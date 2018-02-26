var exports = module.exports = {}

exports.initDb = function(db) {
    var jobs = db.jobs
    if (!jobs) {
        jobs = db.jobs = {}
    }
    if (!jobs.running) {
        jobs.running = []
    }
    if (!jobs.waiting) {
        jobs.waiting = []
    }
    if (!jobs.done) {
        jobs.done = []
    }
}

exports.initApp = function(app, db) {
    app.get('/jobs/:state', function(req, res) {
        res.status(200).send(Object.keys(db.jobs))
    })

    app.put('/jobs/:id', function(req, res) {
        res.status(200).send(Object.keys(db.jobs))
    })

    app.get('/jobs/:id/info', function(req, res) {
        res.status(200).send(Object.keys(db.jobs))
    })

    app.get('/jobs/:id/watch', function(req, res) {
        res.status(200).send(Object.keys(db.jobs))
    })

    app.delete('/jobs/:id', function(req, res) {
        res.status(200).send(Object.keys(db.jobs))
    })
}