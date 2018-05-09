const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const tar = require('tar-fs')
const stream = require('stream')
const rimraf = require('rimraf')
const multer = require('multer')
const cluster = require('cluster')

const store = require('./store.js')
const utils = require('./utils.js')
const config = require('./config.js')
const groupsModule = require('./groups.js')
const { nodeStates, runScriptOnNode } = require('./nodes.js')
const parseClusterRequest = require('./clusterParser.js').parse
const { reserveCluster, summarizeClusterReservation } = require('./reservations.js')

var exports = module.exports = {}

const jobStates = {
    NEW: 0,
    PREPARING: 1,
    WAITING: 2,
    STARTING: 3,
    RUNNING: 4,
    STOPPING: 5,
    CLEANING: 6,
    DONE: 7,
    FAILED: 8
}

exports.jobStates = jobStates

var db = store.root
var pollInterval = config.pollInterval || 1000
var dataRoot = config.dataRoot || path.join(__dirname, '..', 'data')
var upload = multer({ dest: path.join(dataRoot, 'uploads') })
var utilization = {}

process.on('message', msg => {
    if (msg.utilization) {
        utilization = msg.utilization
    }
})

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
            _cleanJob(job, false)
        } else if (job.state == jobStates.CLEANING) {
            _cleanJob(job, true)
        } else {
            _checkRunning(job)
        }
    }
    if (!db.schedule) {
        db.schedule = []
    }
}

function _getJobProcesses() {
    var jobs = {}
    for (let nodeId of Object.keys(db.nodes)) {
        let node = db.nodes[nodeId]
        for (let resource of Object.keys(node.resources).map(k => node.resources[k])) {
            //console.log('Checking resource ' + resource.name + ' (' + resource.index + ') on node ' + node.id)
            if (resource.job && resource.pid && node.state >= nodeStates.ONLINE) {
                let job = jobs[resource.job] = jobs[resource.job] || {}
                let jobnode = job[node.id] = job[node.id] || {}
                jobnode[resource.pid] = true
            }
        }
    }
    return jobs
}

function _checkRunning(job) {
    let counter = 0
    let clusterReservation = job.clusterReservation
    if (!clusterReservation ||
        job.state < jobStates.STARTING ||
        job.state > jobStates.STOPPING) {
        return
    }
    for(let groupReservation of clusterReservation) {
        for(let processReservation of groupReservation) {
            let node = db.nodes[processReservation.node]
            if (node) {
                for(let resource of Object.keys(processReservation.resources)
                    .map(k => node.resources[k])) {
                    if (resource && resource.job == job.id) {
                        return
                    }
                }
            }
        }
    }
    _cleanJob(job, true)
}

function _freeProcess(nodeId, pid) {
    let job = 0
    let node = db.nodes[nodeId]
    for (let resourceId of Object.keys(node.resources)) {
        let resource = node.resources[resourceId]
        if (resource.pid == pid) {
            //console.log('Freeing resource ' + resource.name + ' for PID ' + pid + ' on node "' + node.id + '"')
            job = resource.job
            if (resource.type.startsWith('num:')) {
                delete node.resources[resourceId]
            } else {
                delete resource.pid
                delete resource.job
            }
        }
    }
    if (job > 0 && db.jobs[job]) {
        _checkRunning(db.jobs[job])
    }
}

function _getJobDir(job) {
    return path.join(dataRoot, 'jobs', '' + job.id)
}

function _setJobState(job, state) {
    job.state = state
    job.stateChanges = job.stateChanges || {}
    job.stateChanges[state] = new Date().toISOString()
}

function _getPreparationEnv(job, continueJob) {
    let groups = db.users[job.user].groups
    groups = (groups ? groups.join(' ') + ' ' : '') + 'public'
    let env = {
        DATA_ROOT: dataRoot,
        USER_GROUPS: groups,
        JOB_NUMBER: job.id
    }
    if (continueJob) {
        env.CONTINUE_JOB_NUMBER = continueJob
    }
    return env
}

function _runPreparation(job, env) {
    _setJobState(job, jobStates.PREPARING)
    utils.runScript('prepare.sh', env, (code, stdout, stderr) => {
        store.lockAutoRelease('jobs', () => {
            if (code == 0 && fs.existsSync(_getJobDir(job))) {
                _setJobState(job, jobStates.WAITING)
                db.schedule.push(job.id)
            } else {
                _setJobState(job, jobStates.FAILED)
                job.error = stderr
            }
        })
    })
}

function _prepareJobByGit(job, continueJob, origin, hash, diff) {
    let env = _getPreparationEnv(job, continueJob)
    Object.assign(env, {
        ORIGIN: origin,
        HASH:   hash,
        DIFF:   diff
    })
    _runPreparation(job, env)
}

function _prepareJobByArchive(job, continueJob, archive) {
    let env = _getPreparationEnv(job, continueJob)
    env.ARCHIVE = archive
    _runPreparation(job, env)
}

function _cleanJob(job, success) {
    _setJobState(job, jobStates.CLEANING)
    utils.runScript('clean.sh', _getPreparationEnv(job), (code, stdout, stderr) => {
        store.lockAutoRelease('jobs', () => {
            _setJobState(job, success ? jobStates.DONE : jobStates.FAILED)
            if (code > 0) {
                job.error = stderr
            }
        })
    })
}

function _buildJobEnv(job, clusterReservation) {
    let jobEnv = {
        DATA_ROOT:  dataRoot,
        JOB_NUMBER: job.id,
        JOB_DIR:    _getJobDir(job),
        NUM_GROUPS: clusterReservation.length
    }
    for(let gIndex = 0; gIndex < clusterReservation.length; gIndex++) {
        let groupReservation = clusterReservation[gIndex]
        jobEnv['NUM_PROCESSES_GROUP' + gIndex] = groupReservation.length
        for(let pIndex = 0; pIndex < groupReservation.length; pIndex++) {
            let processReservation = groupReservation[pIndex]
            let node = db.nodes[processReservation.node]
            let portCount = 0
            for(let resourceId of Object.keys(processReservation.resources)) {
                let resource = processReservation.resources[resourceId]
                if (resource.type == 'num:port') {
                    jobEnv[
                        'HOST_GROUP' + processReservation.groupIndex +
                        '_PROCESS' + processReservation.processIndex +
                        '_PORT' + portCount
                    ] = node.address + ':' + resource.index
                    portCount++
                }
            }
            jobEnv['NUM_PORTS_PER_PROCESS_GROUP' + gIndex] = portCount
        }
    }
    return jobEnv
}

function _startJob(job, clusterReservation, callback) {
    _setJobState(job, jobStates.STARTING)
    job.clusterReservation = clusterReservation
    let jobEnv = _buildJobEnv(job, clusterReservation)
    utils.runForEach([].concat.apply([], clusterReservation), (reservation, done) => {
        let cudaIndices = []
        let ports = []
        let node = db.nodes[reservation.node]
        for(let resourceId of Object.keys(reservation.resources)) {
            let resource = reservation.resources[resourceId]
            if (resource.type == 'cuda') {
                cudaIndices.push(resource.index)
            } else if (resource.type == 'num:port') {
                ports.push(resource.index)
            }
        }
        let processEnv = Object.assign({
            GROUP_INDEX:          reservation.groupIndex,
            PROCESS_INDEX:        reservation.processIndex,
            PORTS:                ports.join(','),
            CUDA_VISIBLE_DEVICES: cudaIndices.join(',')
        }, jobEnv)
        runScriptOnNode(node, 'run.sh', processEnv, (code, stdout, stderr) => {
            if (code == 0) {
                let pid = 0
                stdout.split('\n').forEach(line => {
                    let [key, value] = line.split(':')
                    if (key == 'pid' && value) {
                        pid = Number(value)
                    }
                })
                for(let resourceId of Object.keys(reservation.resources)) {
                    let resource = node.resources[resourceId]
                    let resourceReservation = reservation.resources[resourceId]
                    if (!resource && resourceReservation.type.startsWith('num:')) {
                        node.resources[resourceId] = {
                            type: resourceReservation.type,
                            index: resourceReservation.index,
                            job: job.id,
                            pid: pid
                        }
                    } else {
                        resource.job = job.id
                        resource.pid = pid
                    }
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

function _createJobDescription(dbjob) {
    let stateChange = new Date(dbjob.stateChanges[dbjob.state])
    let duration = utils.getDuration(new Date(), stateChange)
    let utilComp = 0
    let utilCompCount = 0
    let utilMem = 0
    let utilMemCount = 0
    if (dbjob.clusterReservation) {
        for(let groupReservation of dbjob.clusterReservation) {
            for(let processReservation of groupReservation) {
                let nodeUtilization = utilization[processReservation.node]
                if (nodeUtilization && processReservation.resources) {
                    for (let resourceId of Object.keys(processReservation.resources)) {
                        let resourceUtilization = nodeUtilization[resourceId]
                        if (resourceUtilization) {
                            if (resourceUtilization.hasOwnProperty('comp')) {
                                utilComp += resourceUtilization.comp
                                utilCompCount++
                            }
                            if (resourceUtilization.hasOwnProperty('mem')) {
                                utilMem += resourceUtilization.mem
                                utilMemCount++
                            }
                        }
                    }
                }
            }
        }
    }
    return {
        id: dbjob.id,
        description: dbjob.description,
        user: dbjob.user,
        groups: dbjob.groups,
        clusterRequest: dbjob.clusterRequest,
        clusterReservation: summarizeClusterReservation(dbjob.clusterReservation),
        state: dbjob.state,
        since: duration,
        schedulePosition: db.schedule.indexOf(dbjob.id),
        utilComp: utilComp / utilCompCount,
        utilMem: utilMem / utilMemCount
    }
}

function _getJobDescription(jobId, user, extended) {
    let dbjob = db.jobs[jobId]
    let job = dbjob ? _createJobDescription(dbjob) : null
    if (job && extended) {
        job.stateChanges = dbjob.stateChanges
        if (dbjob.error) {
            job.error = dbjob.error.trim()
        }
        if(groupsModule.canAccessJob(user, dbjob)) {
            job.provisioning = dbjob.provisioning
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
            if (job.continueJob) {
                let continueJob = db.jobs[job.continueJob]
                if (!continueJob) {
                    res.status(404).send({ message: 'The job to continue is not existing' })
                    return
                }
                if (!groupsModule.canAccessJob(req.user, db.jobs[job.continueJob])) {
                    res.status(403).send({ message: 'Continuing provided job not allowed by current user' })
                    return
                }
            }
            let simulatedReservation = reserveCluster(clusterRequest, req.user, true)
            if (simulatedReservation) {
                let provisioning
                if (job.origin) {
                    provisioning = 'Git commit ' + job.hash + ' from ' + job.origin
                    if (job.diff) {
                        provisioning += ' with ' +
                            (job.diff + '').split('\n').length + ' LoC diff'
                    }
                } else if (job.archive) {
                    provisioning = 'Archive (' + fs.statSync(archive).size + ' bytes)'
                }
                let dbjob = {
                    id: id,
                    user: req.user.id,
                    provisioning: provisioning,
                    description: ('' + job.description).substring(0,20),
                    clusterRequest: job.clusterRequest,
                    clusterReservation: simulatedReservation
                }
                if (!job.private) {
                    dbjob.groups = req.user.autoshare
                }
                _setJobState(dbjob, jobStates.NEW)
                db.jobs[id] = dbjob
                res.status(200).send({ id: id })
                if (job.origin) {
                    _prepareJobByGit(db.jobs[id], job.continueJob, job.origin, job.hash, job.diff)
                } else if (job.archive) {
                    _prepareJobByArchive(db.jobs[id], job.continueJob, archive)
                }
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
        let running = jobs
            .filter(j => j.state >= jobStates.STARTING && j.state <= jobStates.STOPPING)
            .sort((a,b) => a.id - b.id)
        let waiting = jobs
            .filter(j => j.state == jobStates.WAITING)
            .sort((a,b) => db.schedule.indexOf(a.id) - db.schedule.indexOf(b.id))
        waiting = waiting.concat(jobs.filter(j => j.state == jobStates.PREPARING))
        let done = jobs.filter(j => j.state >= jobStates.CLEANING).sort((a,b) => b.id - a.id).slice(0, 20)
        res.status(200).send({
            running: running.map(j => _createJobDescription(j)),
            waiting: waiting.map(j => _createJobDescription(j)),
            done:    done   .map(j => _createJobDescription(j))
        })
    })

    app.get('/jobs/:id', function(req, res) {
        let id = Number(req.params.id)
        let job = _getJobDescription(id, req.user, true)
        if (job) {
            res.status(200).send(job)
        } else {
            res.status(404).send()
        }
    })

    app.get('/jobs/:id/targz', function(req, res) {
        let dbjob = db.jobs[Number(req.params.id)]
        if (dbjob) {
            if (groupsModule.canAccessJob(req.user, dbjob)) {
                let jobdir = _getJobDir(dbjob)
                res.status(200).type('tar.gz')
                tar.pack(jobdir).pipe(zlib.createGzip()).pipe(res)
            } else {
                res.status(403).send()
            }
        } else {
            res.status(404).send()
        }
    })

    app.get('/jobs/:id/groups/:group/processes/:proc/log', function(req, res) {
        let id = Number(req.params.id)
        let dbjob = db.jobs[id]
        let group = Number(req.params.group)
        let proc = Number(req.params.proc)
        if (dbjob &&
            dbjob.clusterReservation &&
            group < dbjob.clusterReservation.length &&
            proc < dbjob.clusterReservation[group].length
        ) {
            if (groupsModule.canAccessJob(req.user, dbjob)) {
                res.writeHead(200, {
                    'Connection': 'keep-alive',
                    'Content-Type': 'text/plain',
                    'Cache-Control': 'no-cache'
                })
                let logPath = path.join(_getJobDir(dbjob), 'process_' + group + '_' + proc + '.log')
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
                                    writeStream(() => setTimeout(poll, pollInterval))
                                } else  {
                                    setTimeout(poll, pollInterval)
                                }
                            })
                        } else {
                            setTimeout(poll, pollInterval)
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
                if (groupsModule.canAccessJob(req.user, dbjob)) {
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
                if (groupsModule.canAccessJob(req.user, dbjob)) {
                    if (dbjob.state >= jobStates.DONE) {
                        let jobdir = _getJobDir(dbjob)
                        delete db.jobs[id]
                        let scheduleIndex = db.schedule.indexOf(id)
                        if (scheduleIndex >= 0) {
                            db.schedule.splice(scheduleIndex, 1)
                        }
                        rimraf(jobdir, err => {
                            if (err) {
                                res.status(500).send()
                            } else {
                                res.status(200).send()
                            }
                        })
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

groupsModule.on('restricted', function() {
    let jobs = []
    for(let job of Object.keys(db.jobs).map(k => db.jobs[k])) {
        if (job.state >= jobStates.PREPARING && job.state <= jobStates.WAITING) {
            let clusterRequest = parseClusterRequest(job.clusterRequest)
            let clusterReservation = reserveCluster(clusterRequest, db.users[job.user], true)
            if (!clusterReservation) {
                jobs.push(job)
            }
        }
    }
    if (jobs.length > 0) {
        store.lockAutoRelease('jobs', function() {
            for (let job of jobs) {
                _setJobState(job, jobStates.FAILED)
                job.error = 'Cluster cannot fulfill resource request anymore'
                let index = db.schedule.indexOf(job.id)
                if (index >= 0) {
                    db.schedule.splice(index, 1)
                }
            }
        })
    }
})

exports.tick = function() {
    let realProcesses = {}
    let utilization = {}
    utils.runForEach(Object.keys(db.nodes).map(k => db.nodes[k]), (node, done) => {
        runScriptOnNode(node, 'pids.sh', { RUN_USER: node.user }, (code, stdout, stderr) => {
            let pids = realProcesses[node.id] = {}
            let nodeUtilization = utilization[node.id] = {}
            for(let line of stdout.split('\n')) {
                if(line.startsWith('pid:')) {
                    pids[Number(line.substr(4))] = true
                } else if (line.startsWith('util:')) {
                    let values = line.substr(5).split(',')
                    nodeUtilization[values[0]] = {
                        comp: Number(values[1]),
                        mem: Number(values[2])
                    }
                }
            }
            done()
        })
    }, () => {
        for(let worker of Object.keys(cluster.workers).map(k => cluster.workers[k])) {
            worker.send({ utilization: utilization })
        }
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
                                _freeProcess(nodeId, pid)
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
            utils.runForEach(toStop, (proc, done) => {
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
                        let clusterReservation = reserveCluster(clusterRequest, db.users[job.user], false)
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