var exports = module.exports = {}

exports.initDb = function(db) {
    if (!db.nodes) {
        db.nodes = {}
    }
}

exports.initApp = function(app, db) {
    app.get('/nodes', function(req, res) {
        res.status(200).send(Object.keys(db.nodes))
    })

    app.put('/nodes/:id', function(req, res) {
        res.status(200).send(Object.keys(db.nodes))
    })

    app.get('/nodes/:id/info', function(req, res) {
        res.status(200).send(Object.keys(db.nodes))
    })

    app.get('/nodes/:id/watch', function(req, res) {
        res.status(200).send(Object.keys(db.nodes))
    })

    app.delete('/nodes/:id', function(req, res) {
        res.status(200).send(Object.keys(db.nodes))
    })
}