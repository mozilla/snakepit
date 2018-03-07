const store = require('./store.js')
const node = require('./nodes.js')

var exports = module.exports = {}
var db = store.root

exports.initDb = function() {
    if (!db.jobIdCounter) {
        db.jobIdCounter = 1
    }
    if (!db.jobs) {
        db.jobs = {}
    }
    if (!db.schedule) {
        db.schedule = []
    }
}

function _getRunningJobs() {
    var jobs = []
    for (let [id, node] of Object.entries(db.nodes)) {
        if (node.state >= nodes.STATE_ACTIVE) {
            let gpuCounter = numGpus 
            gpuReservation = []
            for(let gpu = 0; gpu < node.gpus.length; gpu++) {
                if (node.gpus[gpu].job == 0 || state == 0) {
                    gpuReservation.push(gpu)
                    gpuCounter--
                    if (gpuCounter == 0) {
                        reservation.push({ node: id, gpuReservation: gpuReservation })
                        nodeCounter--
                        if (nodeCounter == 0) return reservation
                        gpuCounter = numGpus
                        gpuReservation = []
                    }
                }
            }
            gpuCounter = numGpus
        }
    }
    return jobs
}

function _reserve(numNodes, numGpus, state) {
    let reservation = []
    let nodeCounter = numNodes
    for (let [id, node] of Object.entries(db.nodes)) {
        if (node.state >= state) {
            let gpuCounter = numGpus 
            gpuReservation = []
            for(let gpu = 0; gpu < node.gpus.length; gpu++) {
                if (node.gpus[gpu].job == 0 || state == 0) {
                    gpuReservation.push(gpu)
                    gpuCounter--
                    if (gpuCounter == 0) {
                        reservation.push({ node: id, gpuReservation: gpuReservation })
                        nodeCounter--
                        if (nodeCounter == 0) return reservation
                        gpuCounter = numGpus
                        gpuReservation = []
                    }
                }
            }
            gpuCounter = numGpus
        }
    }
    return false
}

function _allocate(reservation, jobNumber) {
    reservation.forEach(instanceReservation => {
        var node = db.nodes[instanceReservation.node]
        instanceReservation.gpuReservation.forEach(reservedGpu => node.gpus[reservedGpu].job = jobNumber)
    })
}

function _deallocate(reservation) {
    _allocate(reservation, 0)
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
                    numNodes: job.numNodes,
                    numGpus: job.numGpus
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

exports.tick = function() {
    
}