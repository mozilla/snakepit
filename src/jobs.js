const store = require('./store.js')
const nodes = require('./nodes.js')
const parseClusterRequest = require('./clusterParser.js').parse

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
    var jobs = {}
    Object.keys(db.nodes).forEach(nodeId => {
        let node = db.nodes[nodeId]
        if (node.state >= nodes.STATE_ONLINE) {
            Object.keys(node.resources).forEach(resourceType => {
                let resource = node.resources[resourceType]
                if (resource.job) {
                    jobs[resource.job] = db.jobs[resource.job]
                }
            })      
        }
    })
    return jobs
}

function _getJobProcesses(job) {
    var processes = {}
    Object.keys(db.nodes).forEach(nodeId => {
        let node = db.nodes[nodeId]
        if (node.state >= nodes.STATE_ONLINE) {
            let nodeProcesses = {}
            Object.keys(node.resources).forEach(resourceType => {
                let resource = node.resources[resourceType]
                if (resource.job == job.id && resource.pid) {
                    nodeProcesses[resource.pid] = true
                }
            })
            Object.keys(nodeProcesses).forEach(pid => {
                let pids = processes[nodeId] = processes[nodeId] || []
                pids.push(pid)
            })
        }
    })
    return processes
}

function _mergeReservation(target, source) {
    Object.keys(source).forEach(key => {
        if (!target[key]) {
            target[key] = source[key]
        } else if (typeof target[key] === 'object') {
            _mergeReservation(target[key], source[key])
        }
    })
}

function _reserve(reservation, nodeId, resourceType, resourceIndex) {
    let node = reservation[nodeId] = reservation[nodeId] || {}
    let resource = node[resourceType] = node[resourceType] || {}
    resource[resourceIndex] = true
}

function _isReserved(reservation, nodeId, resourceType, resourceIndex) {
    return reservation[nodeId] && reservation[nodeId][resourceType] && reservation[nodeId][resourceType][resourceIndex]
}

function _reserveProcessOnNode(node, reservation, resourceList) {
    var nodeReservation = {}
    if (!node || !node.resources) {
        return null
    }
    for (let resource of resourceList) {
        let resourceCounter = resource.count
        let name = db.aliases[resource.name] ? db.aliases[resource.name].name : resource.name
        Object.keys(node.resources).forEach(resourceType => {
            if (resourceCounter > 0) {
                let nodeResources = node.resources[resourceType]
                for(let resourceIndex = 0; resourceIndex < nodeResources.length && resourceCounter > 0; resourceIndex++) {
                    let nodeResource = nodeResources[resourceIndex]
                    if (nodeResource.name == name && 
                        !_isReserved(reservation, node.id, resourceType, resourceIndex) && 
                        (!nodeResource.job || state == 0)) {
                        _reserve(nodeReservation, node.id, resourceType, resourceIndex)
                        resourceCounter--
                    }
                }
            }
        })
    }
    return nodeReservation
}

function _reserveProcess(reservation, resourceList, state) {
    Object.keys(db.nodes).forEach(nodeId => {
        let node = db.nodes[nodeId]
        if (node.state >= state) {
            let nodeReservation = _reserveProcessOnNode(node, reservation, resourceList)
            if (nodeReservation) {
                return nodeReservation
            }
        }
    })
    return null
}

function _reserveCluster(clusterRequest, state) {
    let reservation = {}
    clusterRequest.forEach(processRequest => {
        for(let i=0; i<processRequest.count; i++) {
            let processReservation = _reserveProcess(reservation, processRequest.process, state)
            if (processReservation) {
                _mergeReservation(reservation, processReservation)
            } else {
                return null
            }
        }
    })
    return reservation
}

function _allocate(reservation, jobNumber) {
    Object.keys(reservation).forEach(nodeId => {
        let node = db.nodes[nodeId]
        Object.keys(reservation[nodeId]).forEach(resourceType => {
            let resources = node[resourceType]
            Object.keys(reservation[nodeId][resourceType]).forEach(resourceIndex => {
                resources[resourceIndex].job = jobNumber
                if (jobNumber == 0) {
                    resources[resourceIndex].pid = 0
                }
            })
        })
    })
}

function _deallocate(reservation) {
    _allocate(reservation, 0)
}

function _startJob(job) {

}

function _stopJob(job) {

}

exports.initApp = function(app) {
    app.get('/jobs/:state', function(req, res) {
        res.status(200).send()
    })

    app.post('/jobs', function(req, res) {
        store.lockAutoRelease('jobs', function() {
            let id = db.jobIdCounter++
            let job = req.body
            var clusterRequest
            try {
                clusterRequest = parseClusterRequest(job.clusterRequest)
            } catch (ex) {
                console.log(ex)
                res.status(400).send({ message: 'Problem parsing allocation' })
                return
            }
            let reservation = _reserveCluster(clusterRequest, nodes.STATE_UNKNOWN)
            if (reservation) {
                db.jobs[id] = {
                    id: id,
                    user: req.user.id,
                    origin: job.origin,
                    hash: job.hash,
                    diff: job.diff,
                    description: job.description || (req.user.id + ' - ' + new Date().toISOString()),
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
        var id = Number(req.params.id)
        var dbjob = db.jobs[id]
        if (dbjob) {
            if (req.user.id == dbjob.id || req.user.admin) {
                delete db.jobs[id]
                let scheduleIndex = db.schedule.indexOf(id)
                if (scheduleIndex >= 0) {
                    db.schedule.splice(scheduleIndex, 1)
                }
                res.status(200).send()
            } else {
                res.status(403).send()
            }
        } else {
            res.status(404).send()
        }
    })
}

exports.tick = function() {

}