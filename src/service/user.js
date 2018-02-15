
var exports = module.exports = {}

exports.initDb = function(db) {
    if (!db.users) {
        db.users = { 'admin': { token: '' } }
    }
}

exports.initApp = function(app, db) {
    app.get('/users', function(req, res) {
        res.status(200).send(Object.keys(db.users))
    })

    app.get('/users/:id', function(req, res) {
        var id = req.params.id
        var user = db.users[id]
        if (user) {
            res.status(200).send({ id: id, name: user.name, email: user.email })
        } else {
            res.status(404).send()
        }
    })

    app.put('/users/:id', function(req, res) {
        var id = req.params.id
        var user = JSON.parse(req.body)
        if (db.users[id]) {
            res.status(409).send()
        } else {
            db.users[id] = { id: id, name: user.name, email: user.email, password: user.password }
            res.status(200).send()
        }
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