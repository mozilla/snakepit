const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const store = require('./store.js')
const config = require('./config.js')

var exports = module.exports = {}
var db = store.root

exports.initDb = function() {
    if (!db.users) {
        db.users = {}
    }
}

exports.initApp = function(app) {
    app.get('/users/:id/exists', function(req, res) {
        res.status(db.users[req.params.id] ? 200 : 404).send()
    })

    function authorize(req, res, needsUser, callback) {
        var token = req.get('X-Auth-Token')
        if (token) {
            jwt.verify(token, app.get('tokenSecret'), function(err, decoded) {
                if (err) {
                    if (err.name == 'TokenExpiredError') {
                        res.status(401).json({ message: 'Token expired' })
                    } else {
                        res.status(400).json({ message: 'Invalid token' })
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
        } else if (!needsUser) {
            callback()
        } else {
            res.status(401).json({ message: 'No token provided' })
        }
    }

    app.put('/users/:id', function(req, res) {
        var id = req.params.id
        var user = req.body
        authorize(req, res, false, function() {
            if (db.users[id] && req.user && req.user.id !== id && !req.user.admin) {
                res.status(403).send()
            } else {
                var dbuser = db.users[id] || {}
                function setUser(hash) {
                    var admin = dbuser.admin
                    if (Object.keys(db.users).length === 0) {
                        admin = true
                    } else if (req.user && req.user.admin) {
                        if (user.admin == 'yes') {
                            admin = true
                        } else if (user.admin == 'no') {
                            admin = false
                        } else {
                            admin = dbuser.admin
                        }
                    } else if (user.admin == 'yes') {
                        res.status(403).send()
                        return
                    }
                    var newuser = {
                        id: id,
                        fullname: user.fullname || dbuser.fullname,
                        email: user.email || dbuser.email,
                        password: hash,
                        admin: admin
                    }
                    db.users[id] = newuser
                    res.status(200).send()
                }
                if (user.password) {
                    bcrypt.hash(user.password, config.hashRounds || 10, function(err, hash) {
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

    app.post('/users/:id/authenticate', function(req, res) {
        var id = req.params.id
        var user = db.users[id]
        if (user) {
            bcrypt.compare(req.body.password, user.password, function(err, result) {
                if(result) {
                    jwt.sign(
                        { user: id },
                        app.get('tokenSecret'),
                        { expiresIn: config.tokenTTL },
                        function(err, token) {
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
        } else {
            res.status(404).send()
        }
    })

    app.use(function(req, res, next) {
        authorize(req, res, true, next)
    })

    app.get('/users', function(req, res) {
        if (req.user.admin) {
            res.status(200).json(Object.keys(db.users))
        } else {
            res.status(403).send()
        }
    })

    app.get('/users/:id', function(req, res) {
        var id = req.params.id
        if (id == '~') {
            id = req.user.id
        }
        if (req.user.id == id || req.user.admin) {
            var dbuser = db.users[id]
            if (dbuser) {
                res.status(200).json({
                    id: dbuser.id,
                    fullname: dbuser.fullname,
                    email: dbuser.email,
                    admin: dbuser.admin ? 'yes' : 'no'
                })
            } else {
                res.status(404).send()
            }
        } else {
            res.status(403).send()
        }
    })

    app.delete('/users/:id', function(req, res) {
        var id = req.params.id
        if (req.user.id == id || req.user.admin) {
            if (db.users[id]) {
                delete db.users[id]
                res.status(200).send()
            } else {
                res.status(404).send()
            }
        } else {
            res.status(403).send()
        }
    })
}