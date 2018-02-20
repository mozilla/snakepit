const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')

var exports = module.exports = {}

exports.initDb = function(db) {
    if (!db.users) {
        db.users = { }
    }
}

exports.initApp = function(app, db) {
    app.get('/users/:id/exists', function(req, res) {
        res.status(db.users[req.params.id] ? 200 : 404).send()
    })

    function authorize(req, callback) {
        var token = req.headers['X-Auth-Token']
        if (token) {
            jwt.verify(token, app.get('tokenSecret'), function(err, decoded) {
                if (!err) {
                    req.user = db.users[decoded.user]
                }
                callback()
            })
        } else {
            callback()
        }
    }

    app.put('/users/:id', function(req, res) {
        var id = req.params.id
        var user = req.body
        authorize(req, function() {
            if (db.users[id] && !(req.user.id === id || req.user.isadmin)) {
                res.status(409).send()
            } else {
                bcrypt.hash(user.password, app.get('config').hashRounds || 10, function(err, hash) {
                    user = { id: id, fullname: user.fullname, email: user.email, password: hash }
                    if (Object.keys(db.users).length === 0) {
                        user.admin = true
                    }
                    db.users[id] = user
                    res.status(200).send()
                })
            }
        })
    })

    app.post('/users/:id/authenticate', function(req, res) {
        var id = req.params.id
        var user = db.users[id]
        if (user) {
            bcrypt.compare(req.body.password, user.password, function(err, result) {
                if(result) {
                    var token = jwt.sign(
                        { user: id },
                        app.get('tokenSecret'),
                        { expiresIn: app.get('config').tokenTTL },
                        function(err, token) {
                            if (err) {
                                console.log(err)
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

    app.get('/users', function(req, res) {
        res.status(200).send(Object.keys(db.users))
    })

    app.delete('/users/:id', function(req, res) {
        var id = req.params.id
        if (db.users[id]) {
            delete db.users[id]
        } else {
            res.status(404).send()
        }
    })
}