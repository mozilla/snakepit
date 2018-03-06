const store = require('./store.js')

var exports = module.exports = {}
var db = store.root

exports.initDb = function() {
    if (!db.jobIdCounter) {
        db.jobIdCounter = 1
    }
    if (!db.jobs) {
        db.jobs = {}
    }
    if (!db.allocation) {
        db.allocation = {}
    }
    if (!db.schedule) {
        db.schedule = []
    }
}

function _getEmptyCluster() {

}

function _getAllocation(numNodes, numGpus, clusterAllocation) {
    //if (numNodes)
}

function _mergeAllocation(allocation, clusterAllocation) {

}

exports.initApp = function(app) {
    app.get('/jobs/:state', function(req, res) {
        res.status(200).send()
    })

    app.post('/jobs', function(req, res) {
        store.lockAutoRelease('jobs', function() {
            var id = db.jobIdCounter++
            var job = req.body
            var allocation = _getAllocation(job.numNodes, job.numGpus, _getEmptyClusterAllocation())
            if (allocation) {
                db.jobs[id] = {
                    id: id,
                    origin: job.origin,
                    hash: job.hash,
                    diff: job.diff,
                    description: job.description || (req.user.id + ' - ' + new Date().toISOString()),
                    resources: job.resources
                }
                db.schedule.push(id)
                res.status(200).send({ id: id })
            } else {
                res.status(406).send()
            }
        })
    })

    app.get('/jobs/:id', function(req, res) {
        res.status(200).send()
    })

    app.get('/jobs/:id/watch', function(req, res) {
        res.status(200).send()
    })

    app.delete('/jobs/:id', function(req, res) {
        res.status(200).send()
    })
}