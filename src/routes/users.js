const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const Router = require('express-promise-router')

const config = require('../config.js')
const fslib = require('../utils/httpfs.js')

const User = require('../models/User-model.js')

var router = module.exports = new Router()

router.get('/:id/exists', async (req, res) => {
    res.status(db.users[req.params.id] ? 200 : 404).send()
})

function authorize (req, res, needsUser, callback) {
    let token = req.get('X-Auth-Token')
    if (token) {
        jwt.verify(token, config.tokenSecret, function(err, decoded) {
            if (err) {
                if (err.name == 'TokenExpiredError') {
                    res.status(401).json({ message: 'Token expired' })
                } else {
                    res.status(400).json({ message: 'Invalid token ' + err})
                }
            } else {
                req.user = db.users[decoded.user]
                if (req.user) {
                    callback()
                } else {
                    res.status(401).json({ message: 'Token for non-existent user' })
                }
            }
        })
    } else if (needsUser) {
        res.status(401).json({ message: 'No token provided' })
    } else {
        callback()
    }
}

router.ensureSignedIn = (req, res, next) => authorize(req, res, true, next)

router.trySignIn = (req, res, next) => authorize(req, res, false, next)

router.ensureAdmin = (req, res, next) => {
    let checkAdmin = () => req.user.admin ? next() : res.status(403).send()
    req.user ? checkAdmin() : authorize(req, res, true, checkAdmin)
}

router.put('/:id', async (req, res) => {
    let id = req.params.id
    if (!/[a-z]+/.test(id)) {
        res.status(404).send()
    }
    let user = req.body
    authorize(req, res, false, () => {
        let dbuser = await User.findById(id)
        if (dbuser && (!req.user || (req.user && req.user.id !== id && !req.user.admin))) {
            res.status(403).send()
        } else {
            let dbuser = dbuser || User.build({ id: id })
            function setUser(hash) {
                if (Object.keys(db.users).length === 0) {
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
                res.status(200).send()
            }
            if (user.password) {
                bcrypt.hash(user.password, config.hashRounds, (err, hash) => {
                    if(err) {
                        res.status(500).send()
                    } else {
                        setUser(hash)
                    }
                })
            } else if (dbuser.password) {
                setUser(dbuser.password)
            } else {
                res.status(400).send()
            }
        }
    })
})

function targetUser (req, res, next) {
    let id = req.params.id
    if (req.user && id == '~') {
        id = req.user.id
    }
    req.targetUser = id && User.findById(id)
    req.targetUser ? next() : res.status(404).send()
}

router.post('/:id/authenticate', targetUser, async (req, res) => {
    bcrypt.compare(req.body.password, req.targetUser.password, (err, result) => {
        if(result) {
            jwt.sign(
                { user: id },
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
    res.json(User.findAll().map(user => user.id))
})

router.use(router.ensureSignedIn)

router.use(targetUser)

router.use((req, res, next) => {
    if (req.user.id == req.targetUser.id || req.user.admin) {
        next()
    } else {
        res.status(403).send()
    }
})

router.get('/:id', async (req, res) => {
    let dbuser = req.targetUser
    res.json({
        id:        dbuser.id,
        fullname:  dbuser.fullname,
        email:     dbuser.email,
        groups:    dbuser.groups,
        autoshare: dbuser.autoshare,
        admin:     dbuser.admin ? 'yes' : 'no'
    })
})

router.delete('/:id', async (req, res) => {
    await req.targetUser.destroy()
    res.send()
})

router.post('/:id/fs', async (req, res) => {
    let chunks = []
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => fslib.serve(
        fslib.real(req.targetUser.getHomeDir()), 
        Buffer.concat(chunks), 
        result => res.send(result), config.debugJobFS)
    )
})