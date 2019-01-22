const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const Router = require('express-promise-router')
const config = require('../config.js')
const fslib = require('../utils/httpfs.js')
const clusterEvents = require('../utils/clusterEvents.js')
const log = require('../utils/logger.js')
const User = require('../models/User-model.js')
const Group = require('../models/Group-model.js')

var router = module.exports = new Router()

router.get('/:id/exists', async (req, res) => {
    res.status((await User.findByPk(req.params.id)) ? 200 : 404).send()
})

function authorize (req, res, needsUser) {
    return new Promise((resolve, reject) => {
        let token = req.get('X-Auth-Token')
        if (token) {
            jwt.verify(token, config.tokenSecret, (err, decoded) => {
                if (err) {
                    if (err.name == 'TokenExpiredError') {
                        res.status(401).json({ message: 'Token expired' })
                    } else {
                        res.status(400).json({ message: 'Invalid token ' + err})
                    }
                    resolve()
                } else {
                    User.findByPk(decoded.user).then(user => {
                        if (user) {
                            req.user = user
                            resolve('next')
                        } else {
                            res.status(401).json({ message: 'Token for non-existent user' })
                            resolve()
                        }
                    })
                }
            })
        } else if (needsUser) {
            res.status(401).json({ message: 'No token provided' })
            resolve()
        } else {
            resolve()
        }
    })
}

router.ensureSignedIn = (req, res) => authorize(req, res, true)

router.trySignIn = (req, res) => authorize(req, res, false)

router.ensureAdmin = (req, res, next) => {
    let checkAdmin = () => req.user.admin ? next() : res.status(403).send()
    req.user ? checkAdmin() : authorize(req, res, true).then(checkAdmin)
}

router.put('/:id', async (req, res) => {
    let id = req.params.id
    if (!/[a-z]+/.test(id)) {
        res.status(404).send()
    }
    let user = req.body
    await router.trySignIn(req, res)
    let dbuser = await User.findByPk(id)
    if (dbuser && (!req.user || (req.user && req.user.id !== id && !req.user.admin))) {
        res.status(403).send()
    } else {
        dbuser = dbuser || User.build({ id: id })
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
            if (user.autoshare) {
                dbuser.autoshare = user.autoshare
            }
            dbuser.password = hash
            await dbuser.save()
            res.send()
        }
        if (user.password) {
            try {
                let hash = await bcrypt.hash(user.password, config.hashRounds)
                await setUser(hash)
            } catch (ex) {
                log.error(ex, ex.stack)
                res.status(500).send()
            }
        } else if (dbuser.password) {
            await setUser(dbuser.password)
        } else {
            res.status(400).send()
        }
    }
})

async function targetUser (req, res) {
    let id = req.params.id
    if (req.user && id == '~') {
        req.targetUser = req.user
    } else {
        req.targetUser = await User.findByPk(id)
    }
    return req.targetUser ? Promise.resolve('next') : Promise.reject({ code: 404, message: 'User not found' })
}

router.post('/:id/authenticate', targetUser, async (req, res) => {
    bcrypt.compare(req.body.password, req.targetUser.password, (err, result) => {
        if(result) {
            jwt.sign(
                { user: req.targetUser.id },
                config.tokenSecret,
                { expiresIn: config.tokenTTL },
                (err, token) => {
                    if (err) {
                        res.status(500).send()
                    } else {
                        res.status(200).send({ token: token })
                    }
                }
            )
        } else {
            res.status(400).send()
        }
    })
})

router.get('/', router.ensureAdmin, async (req, res) => {
    res.json((await User.findAll()).map(user => user.id))
})

router.use(router.ensureSignedIn)

async function ownerOrAdmin (req, res) {
    return (req.user.id == req.targetUser.id || req.user.admin) ? 
        Promise.resolve('next') : 
        Promise.reject({ code: 403, message: 'Only owner or admin' })
}

router.get('/:id', targetUser, ownerOrAdmin, async (req, res) => {
    let dbuser = req.targetUser
    let groups = (await dbuser.getGroups()).map(group => group.id)
    res.json({
        id:        dbuser.id,
        fullname:  dbuser.fullname,
        email:     dbuser.email,
        groups:    groups.length > 0 ? groups : undefined,
        autoshare: dbuser.autoshare,
        admin:     dbuser.admin ? 'yes' : 'no'
    })
})

router.delete('/:id', targetUser, ownerOrAdmin, async (req, res) => {
    await req.targetUser.destroy()
    res.send()
})

async function targetGroup (req, res) {
    req.targetGroup = await Group.findByPk(req.params.group)
    return req.targetGroup ? Promise.resolve('next') : Promise.reject({ code: 404, message: 'Group not found' })
}

router.put('/:id/groups/:group', router.ensureAdmin, targetUser, targetGroup, async (req, res) => {
    await req.targetUser.addGroup(req.targetGroup)
    res.send()
})

router.delete('/:id/groups/:group', router.ensureAdmin, targetUser, targetGroup, async (req, res) => {
    await req.targetUser.removeGroup(req.targetGroup)
    res.send()
    clusterEvents.emit('restricted')
})

router.post('/:id/fs', targetUser, ownerOrAdmin, async (req, res) => {
    let chunks = []
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => fslib.serve(
        fslib.real(req.targetUser.getDir()), 
        Buffer.concat(chunks), 
        result => res.send(result), config.debugJobFS)
    )
})