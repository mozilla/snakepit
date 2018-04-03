const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const stream = require('stream')
const CombinedStream = require('combined-stream')
const store = require('./store.js')
const config = require('./config.js')
const { nodeStates, runScriptOnNode } = require('./nodes.js')
const parseClusterRequest = require('./clusterParser.js').parse

var exports = module.exports = {}

const jobStates = {
    PREPARING: 0,
    WAITING: 1,
    STARTING: 2,
    RUNNING: 3,
    STOPPING: 4,
    DONE: 5,
    FAILED: 6
}

exports.jobStates = jobStates

var db = store.root

var cacheDir = config.cacheDir || path.join(__dirname, '..', 'data', 'cache')
var jobsDir = config.jobsDir || path.join(__dirname, '..', 'data', 'jobs')

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

function _quote(str) {
    str = '' + str
    str = str.replace(/\\/g, '\\\\')
    str = str.replace(/\'/g, '\\\'')
    str = str.replace(/(?:\r\n|\r|\n)/g, '\\n')
    str = '$\'' + str + '\''
    return str
}

function _runScript(scriptName, env, callback) {
    if (typeof env == 'function') {
        callback = env
        env = {}
    }
    let scriptPath = path.join(__dirname, '..', 'scripts', scriptName)
    fs.readFile(scriptPath, function read(err, content) {
        if (err) {
            callback(1, '', 'Problem reading script "' + scriptPath + '"')
        } else {
            env = env || {}
            //console.log('Running script "' + scriptPath + '"')
            p = spawn('bash', ['-s'])
            let stdout = []
            p.stdout.on('data', data => stdout.push(data))
            let stderr = []
            p.stderr.on('data', data => stderr.push(data))
            p.on('close', code => callback(code, stdout.join('\n'), stderr.join('\n')))
            var stdinStream = new stream.Readable()
            Object.keys(env).forEach(name => stdinStream.push('export ' + name + '=' + _quote(env[name]) + '\n'))
            stdinStream.push(content + '\n')
            stdinStream.push(null)
            stdinStream.pipe(p.stdin)
        }
    })
}

function _forEachResource(callback) {
    for (let nodeId of Object.keys(db.nodes)) {
        let node = db.nodes[nodeId]
        for (let resource of node.resources) {
            callback(node, resource)
        }
    }
}

function _getRunningJobs() {
    var jobs = {}
    _forEachResource((node, resource) => {
        if (resource.job) {
            jobs[resource.job] = db.jobs[resource.job]
        }
    })
    return jobs
}

function _getJobProcesses() {
    var jobs = {}
    _forEachResource((node, resource) => {
        //console.log('Checking resource ' + resource.name + ' (' + resource.index + ') on node ' + node.id)
        if (resource.job && resource.pid && node.state >= nodeStates.ONLINE) {
            let job = jobs[resource.job] = jobs[resource.job] || {}
            let jobnode = job[node.id] = job[node.id] || {}
            jobnode[resource.pid] = true
        }
    })
    return jobs
}

function _freeProcess(pid) {
    let job = 0
    _forEachResource((node, resource) => {
        if (resource.pid == pid) {
            console.log('Freeing resource ' + resource.name + ' for PID ' + pid + ' on node "' + node.id + '"')
            job = resource.job
            resource.pid = 0
            resource.job = 0
        }
    })
    if (job > 0) {
        let counter = 0
        _forEachResource((node, resource) => {
            if (resource.job == job) {
                counter++
            }
        })
        if (counter == 0) {
            db.jobs[job].state = jobStates.DONE
        }
    }
}

function _isReserved(reservations, nodeId, resourceIndex) {
    return reservations.reduce(
        (result, reservation) => result || (reservation.node == nodeId && reservation.resources.includes(resourceIndex)),
        false
    )
}

function _reserveProcessOnNode(node, reservations, resourceList, simulation) {
    var nodeReservation = { node: node.id, resources: [] }
    if (!node || !node.resources) {
        return null
    }
    for (let resource of resourceList) {
        let resourceCounter = resource.count
        let name = db.aliases[resource.name] ? db.aliases[resource.name].name : resource.name
        for(let resourceIndex = 0; resourceIndex < node.resources.length && resourceCounter > 0; resourceIndex++) {
            let nodeResource = node.resources[resourceIndex]
            if (nodeResource.name == name &&
                !_isReserved(reservations, node.id, resourceIndex) &&
                (!nodeResource.job || simulation)
            ) {
                nodeReservation.resources.push(resourceIndex)
                resourceCounter--
            }
        }
        if (resourceCounter > 0) {
            return null
        }
    }
    return nodeReservation
}

function _reserveProcess(reservations, resourceList, simulation) {
    for (let nodeId of Object.keys(db.nodes)) {
        let node = db.nodes[nodeId]
        if (node.state == nodeStates.ONLINE || simulation) {
            let nodeReservation = _reserveProcessOnNode(node, reservations, resourceList, simulation)
            if (nodeReservation) {
                return nodeReservation
            }
        }
    }
    return null
}

function _reserveCluster(clusterRequest, simulation) {
    let reservations = []
    for(let processRequest of clusterRequest) {
        for(let i=0; i<processRequest.count; i++) {
            let processReservation = _reserveProcess(reservations, processRequest.process, simulation)
            if (processReservation) {
                reservations.push(processReservation)
            } else {
                return null
            }
        }
    }
    return reservations
}

function _summarizeClusterReservation(reservations) {
    let nodes = {}
    for(let processReservation of reservations) {
        let node = nodes[processReservation.node]
        if (node) {
            node.resources = node.resources.concat(processReservation.resources)
        } else {
            nodes[processReservation.node] = {
                id: processReservation.node,
                resources: [].concat(processReservation.resources)
            }
        }
    }
    console.log(JSON.stringify(nodes))
    let summary = ''
    for (let nodeId of Object.keys(nodes)) {
        let node = nodes[nodeId]
        let resources = node.resources
        resources.sort()
        if (summary != '') {
            summary += ' + '
        }
        summary += nodeId
        summary += '['
        let range = null
        let addRange = () => summary += range.start == range.stop ? range.start : (range.start + '-' + range.stop)
        let lastType = null
        for(let resourceIndex of node.resources) {
            let dbresource = db.nodes[nodeId].resources[resourceIndex]
            if (lastType != dbresource.type) {
                if (range) {
                    addRange()
                    summary += ' + '
                }
                summary += dbresource.type + ' '
                lastType = dbresource.type
                range = { start: dbresource.index, stop: dbresource.index }
            } else {
                if (range.stop + 1 < dbresource.index) {
                    addRange()
                    summary += ','
                    range = { start: dbresource.index, stop: dbresource.index }
                } else {
                    range.stop = dbresource.index
                }
            }
        }
        if (range) {
            addRange()
        }
        summary += ']'
    }
    return summary
}

function _getJobDir(job) {
    return path.join(jobsDir, '' + job.id)
}

function _prepareJob(job) {
    _runScript('prepare.sh', {
        CACHE_DIR: cacheDir,
        JOBS_DIR:  jobsDir,
        JOB_NAME:  job.id,
        ORIGIN:    job.origin,
        HASH:      job.hash,
        DIFF:      job.diff
    }, (code, stdout, stderr) => {
        store.lockAutoRelease('jobs', () => {
            if (code == 0 && fs.existsSync(_getJobDir(job))) {
                job.state = jobStates.WAITING
                db.schedule.push(job.id)
            } else {
                job.state = jobStates.FAILED
                job.result = stderr
                console.log(stdout)
                console.log(stderr)
            }
        })
    })
}

function _startJob(job, clusterReservation, callback) {
    job.state = jobStates.STARTING
    job.clusterReservation = _summarizeClusterReservation(clusterReservation)
    _runForEach(clusterReservation, (reservation, done) => {
        let processIndex = clusterReservation.indexOf(reservation)
        let cudaIndices = []
        let node = db.nodes[reservation.node]
        for(let resourceIndex in reservation.resources) {
            let resource = node.resources[resourceIndex]
            if (resource.type == 'cuda') {
                cudaIndices.push(resource.index)
            }
        }
        runScriptOnNode(node, 'run.sh', {
            JOB_NUMBER:           job.id,
            JOB_DIR:              _getJobDir(job),
            PROCESS_INDEX:        processIndex,
            CUDA_VISIBLE_DEVICES: cudaIndices.join(',')
        }, (code, stdout, stderr) => {
            if (code == 0) {
                let pid = 0
                stdout.split('\n').forEach(line => {
                    let [key, value] = line.split(':')
                    if (key == 'pid' && value) {
                        pid = Number(value)
                    }
                })
                for(let resourceIndex of reservation.resources) {
                    let resource = node.resources[resourceIndex]
                    resource.job = job.id
                    resource.pid = pid
                }
            } else {
                job.state = jobStates.STOPPING
            }
            done()
        })
    }, () => {
        if (job.state == jobStates.STARTING) {
            job.state = jobStates.RUNNING
        }
        callback()
    })
}

exports.initApp = function(app) {
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
            if (_reserveCluster(clusterRequest, true)) {
                db.jobs[id] = {
                    id: id,
                    user: req.user.id,
                    origin: job.origin,
                    hash: job.hash,
                    diff: job.diff,
                    description: job.description || (req.user.id + ' - ' + new Date().toISOString()),
                    clusterRequest: job.clusterRequest,
                    state: jobStates.PREPARING
                }
                console.log('added job')
                res.status(200).send({ id: id })
                console.log('preparing job')
                _prepareJob(db.jobs[id])
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

    app.post('/jobs/:id/stop', function(req, res) {
        store.lockAutoRelease('jobs', function() {
            var id = Number(req.params.id)
            var dbjob = db.jobs[id]
            if (dbjob) {
                if (req.user.id == dbjob.user || req.user.admin) {
                    if (dbjob.state == jobStates.STARTING || dbjob.state == jobStates.RUNNING) {
                        dbjob.state = jobStates.STOPPING
                        res.status(200).send()
                    } else {
                        res.status(412).send()
                    }
                } else {
                    res.status(403).send()
                }
            } else {
                res.status(404).send()
            }
        })
    })

    app.delete('/jobs/:id', function(req, res) {
        store.lockAutoRelease('jobs', function() {
            var id = Number(req.params.id)
            var dbjob = db.jobs[id]
            if (dbjob) {
                if (req.user.id == dbjob.user || req.user.admin) {
                    if (dbjob.state >= jobStates.DONE) {
                        delete db.jobs[id]
                        let scheduleIndex = db.schedule.indexOf(id)
                        if (scheduleIndex >= 0) {
                            db.schedule.splice(scheduleIndex, 1)
                        }
                        res.status(200).send()
                    } else {
                        res.status(412).send()
                    }
                } else {
                    res.status(403).send()
                }
            } else {
                res.status(404).send()
            }
        })
    })

    app.get('/jobs', function(req, res) {
        let jobs = []
        for (let jobId of Object.keys(db.jobs)) {
            let dbjob = db.jobs[jobId]
            jobs.push({
                id: dbjob.id,
                user: dbjob.user,
                description: dbjob.description,
                clusterRequest: dbjob.clusterRequest,
                clusterReservation: dbjob.clusterReservation,
                state: dbjob.state,
                schedulePosition: db.schedule.indexOf(dbjob.id)
            })
        }
        res.status(200).send(jobs)
    })
}

function _runForEach(col, fun, callback) {
    let counter = col.length
    let done = () => {
        counter--
        if (counter == 0) {
            callback()
        }
    }
    if (col.length > 0) {
        for(let item of col) {
            fun(item, done)
        }
    } else {
        callback()
    }
}

exports.tick = function() {
    let realProcesses = {}
    let currentNodes = Object.keys(db.nodes).map(k => db.nodes[k])
    _runForEach(currentNodes, (node, done) => {
        runScriptOnNode(node, 'pids.sh', { RUN_USER: node.user }, (code, stdout, stderr) => {
            let pids = realProcesses[node.id] = {}
            for(let line of stdout.split('\n')) {
                if(line.startsWith('pid:')) {
                    pids[Number(line.substr(4))] = true
                }
            }
            done()
        })
    }, () => {
        store.lockAsyncRelease('jobs', release => {
            let goon = () => {
                release()
                setTimeout(exports.tick, 1000)
            }
            let processes = _getJobProcesses()
            let toStop = []
            for(let jobId of Object.keys(processes)) {
                let job = db.jobs[jobId]
                let toStopForJob = []
                let jobProcesses = processes[jobId]
                for(let nodeId of Object.keys(jobProcesses)) {
                    let nodeProcesses = jobProcesses[nodeId]
                    let realNodeProcesses = realProcesses[nodeId]
                    if (realNodeProcesses) {
                        for(let pid of Object.keys(nodeProcesses)) {
                            if (realNodeProcesses[pid]) {
                                toStopForJob.push({ node: nodeId, pid: pid })
                            } else {
                                job.state = jobStates.STOPPING
                                _freeProcess(pid)
                            }
                        }
                    } else {
                        job.state = jobStates.STOPPING
                    }
                }
                if (job.state == jobStates.STOPPING && toStopForJob.length > 0) {
                    toStop = toStop.concat(toStopForJob)
                }
            }
            _runForEach(toStop, (proc, done) => {
                console.log(proc)
                runScriptOnNode(db.nodes[proc.node], 'kill.sh', { PID: proc.pid }, (code, stdout, stderr) => {
                    if (code == 0) {
                        console.log('Ended PID: ' + proc.pid)
                    } else {
                        console.log('Problem ending PID: ' + proc.pid)
                    }
                    done()
                })
            }, () => {
                if (db.schedule.length > 0) {
                    let job = db.jobs[db.schedule[0]]
                    if (job) {
                        let clusterRequest = parseClusterRequest(job.clusterRequest)
                        let clusterReservation = _reserveCluster(clusterRequest, false)
                        if (clusterReservation) {
                            db.schedule.shift()
                            _startJob(job, clusterReservation, goon)
                        } else {
                            goon()
                        }
                    } else {
                        db.schedule.shift()
                        goon()
                    }
                } else {
                    goon()
                }
            })
        })
    })
}