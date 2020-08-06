const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const Router = require('express-promise-router')
const config = require('../config.js')
const simplefs = require('../utils/simplefs.js')
const clusterEvents = require('../utils/clusterEvents.js')
const log = require('../utils/logger.js')
const Job = require('../models/Job-model.js')
const User = require('../models/User-model.js')
const { trySignIn,
        ensureSignedIn,
        ensureVerified,
        ensureAdmin,
        selfOrAdmin,
        tryTargetUser,
        targetUser,
        targetGroup } = require('./mw.js')

var router = module.exports = new Router()

router.get('/:user/exists', async (req, res) => {
    res.status((await User.findByPk(req.params.user)) ? 200 : 404).send()
})

async function applyAndSaveUserConfig (targetUser, userConfig) {
    if (userConfig.fullname) {
        targetUser.fullname = userConfig.fullname
    }
    if (userConfig.email) {
        targetUser.email = userConfig.email
    }
    if (userConfig.password) {
        targetUser.password = await bcrypt.hash(userConfig.password, config.hashRounds)
    }
    await targetUser.save()
}

router.put('/:user', trySignIn, tryTargetUser, async (req, res) => {
    if (req.targetUser) {
        return Promise.reject({ code: 403, message: 'User already existing' })
    } else {
        if (!(req.user && req.user.admin) && await Job.findOne({ where: { userId: req.params.user } })) {
            return Promise.reject({ code: 403, message: 'Only admins can re-create this account, as there are already jobs with this user-ID as owner.' })
        }
    }
    await applyAndSaveUserConfig(User.build({ id: req.params.user }), req.body)
    res.send()
})

router.post('/:user/authenticate', targetUser, async (req, res) => {
    bcrypt.compare(req.body.password, req.targetUser.password, (err, result) => {
        if(result) {
            jwt.sign(
                { user: req.targetUser.id },
                config.tokenSecret,
                { expiresIn: config.tokenTTL / 1000 },
                (err, token) => {
                    if (err) {
                        log.error('Problem signing JWT for user', req.targetUser.id)
                        res.status(500).send()
                    } else {
                        res.status(200).send({ token: token })
                    }
                }
            )
        } else {
            log.error('Wrong password - User', req.targetUser.id)
            res.status(400).send()
        }
    })
})

router.get('/', ensureAdmin, async (req, res) => {
    res.json((await User.findAll()).map(user => user.id))
})

router.use(ensureSignedIn)

router.post('/:user', targetUser, selfOrAdmin, ensureVerified, async (req, res) => {
    let userConfig = req.body
    if (userConfig.admin === true) {
        if (req.user.admin) {
            req.targetUser.admin = true
        } else {
            return Promise.reject({ code: 403, message: 'Not allowed' })
        }
    } else if (userConfig.admin === false) {
        req.targetUser.admin = false
    }
    await applyAndSaveUserConfig(req.targetUser, userConfig)
    if (userConfig.autoshare) {
        await req.targetUser.setAutoShares(userConfig.autoshare)
    }
    res.send()
})

router.get('/:user', targetUser, selfOrAdmin, async (req, res) => {
    let groups = (await req.targetUser.getUsergroups()).map(ug => ug.groupId)
    let autoshares = (await req.targetUser.getAutoshares()).map(a => a.groupId)
    res.json({
        id:        req.targetUser.id,
        fullname:  req.targetUser.fullname,
        email:     req.targetUser.email,
        groups:    groups.length > 0 ? groups : undefined,
        autoshare: autoshares.length > 0 ? autoshares : undefined,
        admin:     req.targetUser.admin
    })
})

router.delete('/:user', targetUser, selfOrAdmin, async (req, res) => {
    await req.targetUser.destroy()
    res.send()
})

router.put('/:user/groups/:group', ensureAdmin, targetUser, targetGroup, async (req, res) => {
    await User.UserGroup.upsert({ userId: req.targetUser.id, groupId: req.targetGroup.id })
    res.send()
})

router.delete('/:user/groups/:group', ensureAdmin, targetUser, targetGroup, async (req, res) => {
    await User.UserGroup.destroy({ where: { userId: req.targetUser.id, groupId: req.targetGroup.id } })
    res.send()
    clusterEvents.emit('restricted')
})

router.all('/:user/simplefs/' + simplefs.pattern, targetUser, selfOrAdmin, async (req, res) => {
    let baseDir = User.getDir(req.targetUser.id)
    await simplefs.performCommand(baseDir, req, res)
})
