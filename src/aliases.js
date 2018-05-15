const db = require('./database.js')

var exports = module.exports = {}

exports.initApp = function(app) {
    app.get('/aliases', function(req, res) {
        res.status(200).send(Object.keys(db.aliases))
    })

    app.put('/aliases/:id', function(req, res) {
        if (req.user.admin) {
            if (req.body && req.body.name) {
                let params = {
                    $id: req.params.id,
                    $name: req.body.name
                }
                db.serialize(() => {
                    db.run('UPDATE aliases SET alias=$alias, name=$name WHERE alias=$alias', params) 
                    db.run('INSERT OR IGNORE INTO aliases (alias, name) VALUES ($alias, $name)', params)
                })
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
            db.run('DELETE FROM aliases WHERE alias=?', [req.params.id])
            res.status(200).send()
        } else {
            res.status(403).send()
        }
    })
}