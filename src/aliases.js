const store = require('./store.js')

var exports = module.exports = {}

var db = store.root

exports.initDb = function() {
    if (!db.aliases) {
        db.aliases = {}
    }
}

exports.initApp = function(app) {
    app.get('/aliases', function(req, res) {
        res.status(200).send(Object.keys(db.aliases))
    })

    app.put('/aliases/:id', function(req, res) {
        if (req.user.admin) {
            if (req.body && req.body.model) {
                db.aliases[req.params.id] = {
                    id: req.params.id,
                    model: req.body.model
                }
                res.status(200).send()
            } else {
                res.status(400).send()
            }
        } else {
            res.status(403).send()
        }
    })

    app.delete('/aliases/:id', function(req, res) {
        if (req.user.admin) {
            delete db.aliases[req.params.id]
        } else {
            res.status(403).send()
        }
    })
}