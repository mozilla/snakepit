const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const Router = require('express-promise-router')
const config = require('../config.js')
const fslib = require('../utils/httpfs.js')
const clusterEvents = require('../utils/clusterEvents.js')
const log = require('../utils/logger.js')
const User = require('../models/User-model.js')
const Group = require('../models/Group-model.js')
const { trySignIn,
        ensureSignedIn,
        ensureAdmin,
        selfOrAdmin,
        tryTargetUser,
        targetUser,
        targetGroup } = require('./mw.js')

var router = module.exports = new Router()

router.get('/:user/exists', async (req, res) => {
    res.status((await User.findByPk(req.params.user)) ? 200 : 404).send()
})

router.put('/:user', trySignIn, tryTargetUser, async (req, res) => {
    if (req.targetUser && (!req.user || (req.user && req.user.id !== req.params.user && !req.user.admin))) {
        res.status(403).send()
    } else {
        let user = req.body
        let dbuser = req.targetUser || User.build({ id: req.params.user })
        let setUser = async (hash) => {
            if ((await User.count()) === 0) {
                dbuser.admin = true
            } else if (req.user && req.user.admin) {
                if (user.admin == 'yes') {
                    dbuser.admin = true
                } else if (user.admin == 'no') {
                    dbuser.admin = false
                }
            } else if (user.admin == 'yes') {
                res.status(403).send()
                return
            }
            if (user.fullname) {
                dbuser.fullname = user.fullname
            }
            if (user.email) {
                dbuser.email = user.email
            }
            dbuser.password = hash
            await dbuser.save()
            if (user.autoshare) {
                for(let asg of user.autoshare) {
                    if (await Group.findByPk(asg)) {
                        await User.AutoShare.insertOrUpdate({
                            userId:  dbuser.id,
                            groupId: asg
                        })
                    }
                }
            }
            res.send()
        }
        if (user.password) {
            try {
                let hash = await bcrypt.hash(user.password, config.hashRounds)
                await setUser(hash)
            } catch (ex) {
                res.status(500).send()
            }
        } else if (dbuser.password) {
            await setUser(dbuser.password)
        } else {
            res.status(400).send()
        }
    }
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

router.get('/:user', targetUser, selfOrAdmin, async (req, res) => {
    let dbuser = req.targetUser
    let groups = (await dbuser.getUsergroups()).map(ug => ug.groupId)
    let autoshares = (await dbuser.getAutoshares()).map(a => a.groupId)
    res.json({
        id:        dbuser.id,
        fullname:  dbuser.fullname,
        email:     dbuser.email,
        groups:    groups.length > 0 ? groups : undefined,
        autoshare: autoshares.length > 0 ? autoshares : undefined,
        admin:     dbuser.admin ? 'yes' : 'no'
    })
})

router.delete('/:user', targetUser, selfOrAdmin, async (req, res) => {
    await req.targetUser.destroy()
    res.send()
})

router.put('/:user/groups/:group', ensureAdmin, targetUser, targetGroup, async (req, res) => {
    await User.UserGroup.insertOrUpdate({ userId: req.targetUser.id, groupId: req.targetGroup.id })
    res.send()
})

router.delete('/:user/groups/:group', ensureAdmin, targetUser, targetGroup, async (req, res) => {
    await User.UserGroup.destroy({ where: { userId: req.targetUser.id, groupId: req.targetGroup.id } })
    res.send()
    clusterEvents.emit('restricted')
})

router.post('/:user/fs', targetUser, selfOrAdmin, async (req, res) => {
    let chunks = []
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => fslib.serve(
        fslib.real(req.targetUser.getDir()), 
        Buffer.concat(chunks), 
        result => res.send(result), config.debugJobFS)
    )
})