const fs = require('fs')
const readline = require('readline')
const path = require('path')
const { spawn } = require('child_process')
const stream = require('stream')
const CombinedStream = require('combined-stream')
const { MultiRange } = require('multi-integer-range')

const store = require('./store.js')
const config = require('./config.js')
const { nodeStates, runScriptOnNode } = require('./nodes.js')
const parseClusterRequest = require('./clusterParser.js').parse

var exports = module.exports = {}

const jobStates = {
    NEW: 0,
    PREPARING: 1,
    WAITING: 2,
    STARTING: 3,
    RUNNING: 4,
    STOPPING: 5,
    DONE: 6,
    FAILED: 7
}

const POLL_INTERVAL = 100

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
    for (let jobId of Object.keys(db.jobs)) {
        let job = db.jobs[jobId]
        if (job.state == jobStates.PREPARING) {
            _prepareJob(job)
        }
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
    let job  = 0
    _forEachResource((node, resource) => {
        if (resource.pid == pid) {
            //console.log('Freeing resource ' + resource.name + ' for PID ' + pid + ' on node "' + node.id + '"')
            job = resource.job
            delete resource.pid
            delete resource.job
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
            _setJobState(db.jobs[job], jobStates.DONE)
        }
    }
}

function _isReserved(clusterReservation, nodeId, resourceIndex) {
    return clusterReservation.reduce(
        (result, reservation) => result || (reservation.node == nodeId && reservation.resources.includes(resourceIndex)),
        false
    )
}

function _reserveProcessOnNode(node, clusterReservation, resourceList, simulation) {
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
                !_isReserved(clusterReservation, node.id, resourceIndex) &&
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

function _reserveProcess(clusterReservation, resourceList, simulation) {
    for (let nodeId of Object.keys(db.nodes)) {
        let node = db.nodes[nodeId]
        if (node.state == nodeStates.ONLINE || simulation) {
            let nodeReservation = _reserveProcessOnNode(node, clusterReservation, resourceList, simulation)
            if (nodeReservation) {
                return nodeReservation
            }
        }
    }
    return null
}

function _reserveCluster(clusterRequest, simulation) {
    let clusterReservation = []
    for(let processRequest of clusterRequest) {
        for(let i=0; i<processRequest.count; i++) {
            let processReservation = _reserveProcess(clusterReservation, processRequest.process, simulation)
            if (processReservation) {
                clusterReservation.push(processReservation)
            } else {
                return null
            }
        }
    }
    return clusterReservation
}

function _summarizeClusterReservation(clusterReservation) {
    let nodes = {}
    for(let processReservation of clusterReservation) {
        nodes[processReservation.node] = (nodes[processReservation.node] || [])
            .concat(processReservation.resources)
    }
    let summary = ''
    for(let nodeId of Object.keys(nodes)) {
        let nodeResources = nodes[nodeId]
        let dbnode = db.nodes[nodeId]
        if (summary != '') {
            summary += ' + '
        }
        summary += nodeId + '['
        let first = true
        for(let type of dbnode.resources.map(r => r.type).filter((v, i, a) => a.indexOf(v) === i)) {
            let resources = nodeResources.filter(ri => dbnode.resources[ri].type == type)
                .map(ri => dbnode.resources[ri].index)
            if (resources.length > 0) {
                if (!first) {
                    summary += ' + '
                }
                summary += type + ' ' + new MultiRange(resources.join(',')).getRanges()
                    .map(range => range[0] == range[1] ? range[0] : range[0] + '-' + range[1])
                    .join(',')
                first = false
            }
        }
        summary += ']'
    }
    return summary
}

function _getJobDir(job) {
    return path.join(jobsDir, '' + job.id)
}

function _setJobState(job, state) {
    job.state = state
    job.stateChanges = job.stateChanges || {}
    job.stateChanges[state] = new Date().toISOString()
}

function _prepareJob(job) {
    _setJobState(job, jobStates.PREPARING)
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
                _setJobState(job, jobStates.WAITING)
                db.schedule.push(job.id)
            } else {
                _setJobState(job, jobStates.FAILED)
                job.result = stderr
                console.error(stdout)
                console.error(stderr)
            }
        })
    })
}

function _startJob(job, clusterReservation, callback) {
    _setJobState(job, jobStates.STARTING)
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
                _setJobState(job, jobStates.STOPPING)
            }
            done()
        })
    }, () => {
        if (job.state == jobStates.STARTING) {
            _setJobState(job, jobStates.RUNNING)
        }
        callback()
    })
}

function _getDuration(date1, date2) {
    let delta = Math.abs(date2 - date1) / 1000
    let days = Math.floor(delta / 86400)
    delta -= days * 86400
    let hours = Math.floor(delta / 3600) % 24
    delta -= hours * 3600
    let minutes = Math.floor(delta / 60) % 60
    delta -= minutes * 60
    let seconds = Math.floor(delta % 60)
    return {
        days: days,
        hours: hours,
        minutes: minutes,
        seconds: seconds
    }
}

function _createJobDescription(dbjob) {
    let stateChange = new Date(dbjob.stateChanges[dbjob.state])
    let duration = _getDuration(new Date(), stateChange)
    return {
        id: dbjob.id,
        user: dbjob.user,
        description: dbjob.description,
        clusterRequest: dbjob.clusterRequest,
        clusterReservation: dbjob.clusterReservation,
        state: dbjob.state,
        since: duration,
        schedulePosition: db.schedule.indexOf(dbjob.id),
        numProcesses: dbjob.numProcesses
    }
}

function _getJobDescription(jobId, user, extended) {
    let dbjob = db.jobs[jobId]
    let job = dbjob ? _createJobDescription(dbjob) : null
    if (job && extended) {
        job.stateChanges = dbjob.stateChanges
        if(user == dbjob.user) {
            job.origin = dbjob.origin
            job.hash = dbjob.hash
            job.diff = dbjob.diff
        }
    }
    return job
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
                res.status(400).send({ message: 'Problem parsing allocation' })
                return
            }
            let simulatedReservation = _reserveCluster(clusterRequest, true)
            if (simulatedReservation) {
                let dbjob = {
                    id: id,
                    user: req.user.id,
                    origin: job.origin,
                    hash: job.hash,
                    diff: job.diff,
                    description: ('' + job.description).substring(0,20),
                    clusterRequest: job.clusterRequest,
                    numProcesses: simulatedReservation.length
                }
                _setJobState(dbjob, jobStates.NEW)
                db.jobs[id] = dbjob
                res.status(200).send({ id: id })
                _prepareJob(db.jobs[id])
            } else {
                res.status(406).send({ message: 'Cluster cannot fulfill resource request' })
            }
        })
    })

    app.get('/jobs', function(req, res) {
        res.status(200).send(Object.keys(db.jobs))
    })

    app.get('/status', function(req, res) {
        let jobs = Object.keys(db.jobs).map(k => db.jobs[k])
        let running = jobs.filter(j => j.state >= jobStates.STARTING && j.state <= jobStates.STOPPING).sort((a,b) => a.id - b.id)
        let waiting = jobs.filter(j => j.state == jobStates.WAITING).sort((a,b) => db.schedule.indexof(a.id) - db.schedule.indexof(b.id))
        waiting = waiting.concat(jobs.filter(j => j.state == jobStates.PREPARING))
        let done = jobs.filter(j => j.state >= jobStates.DONE).sort((a,b) => b.id - a.id).slice(0, 20)
        res.status(200).send({
            running: running.map(j => _createJobDescription(j)),
            waiting: waiting.map(j => _createJobDescription(j)),
            done:    done   .map(j => _createJobDescription(j))
        })
    })

    app.get('/jobs/:id', function(req, res) {
        let id = Number(req.params.id)
        let job = _getJobDescription(id, req.user.id, true)
        if (job) {
            res.status(200).send(job)
        } else {
            res.status(404).send()
        }
    })

    app.get('/jobs/:id/processes/:proc/log', function(req, res) {
        let id = Number(req.params.id)
        let dbjob = db.jobs[id]
        let proc = Number(req.params.proc)
        if (dbjob && proc < dbjob.numProcesses) {
            if (req.user.id == dbjob.user || req.user.admin) {
                res.writeHead(200, {
                    'Connection': 'keep-alive',
                    'Content-Type': 'text/plain',
                    'Cache-Control': 'no-cache'
                })
                let logPath = path.join(_getJobDir(dbjob), 'process_' + proc + '.log')
                let written = 0
                let writeStream = cb => {
                    let stream = fs.createReadStream(logPath, { start: written })
                    stream.on('data', chunk => {
                        res.write(chunk)
                        written += chunk.length
                    })
                    stream.on('end', cb)
                }
                let poll = () => {
                    if (dbjob.state <= jobStates.STOPPING) {
                        if (fs.existsSync(logPath)) {
                            fs.stat(logPath, (err, stats) => {
                                if (!err && stats.size > written) {
                                    writeStream(() => setTimeout(poll, POLL_INTERVAL))
                                } else  {
                                    setTimeout(poll, POLL_INTERVAL)
                                }
                            })
                        } else {
                            setTimeout(poll, POLL_INTERVAL)
                        }
                    } else if (fs.existsSync(logPath)) {
                        writeStream(res.end.bind(res))
                    }
                }
                poll()
            } else {
                res.status(403).send()
            }
        } else {
            res.status(404).send()
        }
    })

    app.post('/jobs/:id/stop', function(req, res) {
        store.lockAutoRelease('jobs', function() {
            var id = Number(req.params.id)
            var dbjob = db.jobs[id]
            if (dbjob) {
                if (req.user.id == dbjob.user || req.user.admin) {
                    if (dbjob.state == jobStates.STARTING || dbjob.state == jobStates.RUNNING) {
                        _setJobState(dbjob, jobStates.STOPPING)
                        res.status(200).send()
                    } else {
                        res.status(412).send({ message: 'Only starting or running jobs can be stopped' })
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
                        res.status(412).send({ message: 'Only failed or done jobs can be deleted' })
                    }
                } else {
                    res.status(403).send()
                }
            } else {
                res.status(404).send()
            }
        })
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
                                _setJobState(job, jobStates.STOPPING)
                                _freeProcess(pid)
                            }
                        }
                    } else {
                        _setJobState(job, jobStates.STOPPING)
                    }
                }
                if (job.state == jobStates.STOPPING && toStopForJob.length > 0) {
                    toStop = toStop.concat(toStopForJob)
                }
            }
            _runForEach(toStop, (proc, done) => {
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