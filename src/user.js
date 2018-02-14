
var exports = module.exports = {}

exports.initDb = function(db) {
    console.log(JSON.stringify(db))
    console.log(!!db.users)
    if (!db.users) {
        console.log('Was soll das?')
        db.users = { 'admin': { token: '' } }
    }
}

exports.initApp = function(app, db) {
    
    app.get('/users', function(req, res) {
        res.status(200).send({ users: db.users })
        console.log(JSON.stringify(db.users))
    })

    app.get('/users/add', function(req, res) {
        var id = req.query.id
        if (db.users[id])
            res.status(400).send()
        else {
            db.users[id] = { id: id, name: req.query.name, email: req.query.email }
            res.status(200).send()
        }
    })
}