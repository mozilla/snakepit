const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const tar = require('tar-fs')
const stream = require('stream')
const rimraf = require('rimraf')
const multer = require('multer')
const cluster = require('cluster')
const parseDuration = require('parse-duration')

const store = require('./store.js')
const utils = require('./utils.js')
const config = require('./config.js')
const nodesModule = require('./nodes.js')
const groupsModule = require('./groups.js')
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
    ARCHIVED: 8
}

exports.jobStates = jobStates

const oneSecond = 1000
const oneMinute = 60 * oneSecond
const oneHour = 60 * oneMinute
const oneDay = 24 * oneHour

var db = store.root
var pollInterval = config.pollInterval ? Number(config.pollInterval) : oneSecond
var keepDoneDuration = config.keepDoneDuration ? parseDuration(config.keepDoneDuration) : 7 * oneDay
var maxPrepDuration = config.maxPrepDuration ? parseDuration(config.maxPrepDuration) : oneHour
var maxStartDuration = config.maxStartDuration ? parseDuration(config.maxStartDuration) : 5 * oneMinute
var maxParallelPrep = config.maxParallelPrep ? Number(config.maxParallelPrep) : 2
var dataRoot = config.dataRoot || '/snakepit'
var sharedDir = path.join(dataRoot, 'shared')
var upload = multer({ dest: path.join(dataRoot, 'uploads') })
var utilization = {}
var preparations = {}

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
            _appendError(job, 'Job was interrupted during preparation')
            _cleanJob(job)
        } else if (job.state == jobStates.CLEANING) {
            _cleanJob(job)
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
        if (node.state >= nodesModule.nodeStates.ONLINE) {
            for (let resource of Object.keys(node.resources).map(k => node.resources[k])) {
                //console.log('Checking resource ' + resource.name + ' (' + resource.index + ') on node ' + node.id)
                if (resource.job && resource.pid) {
                    let job = jobs[resource.job] = jobs[resource.job] || {}
                    let jobnode = job[node.id] = job[node.id] || {}
                    jobnode[resource.pid] = true
                }
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
    _cleanJob(job)
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

function _getJobsDir() {
    return path.join(dataRoot, 'jobs')
}

function _getJobDirById(jobId) {
    return path.join(_getJobsDir(), jobId + '')
}

function _getJobDir(job) {
    return _getJobDirById(job.id)
}

function _loadJob(jobId) {
    let job = db.jobs[jobId]
    if (job) {
        return job
    }
    let jobPath = path.join(_getJobDirById(jobId), 'meta.json')
    if (fs.existsSync(jobPath)) {
        return JSON.parse(fs.readFileSync(jobPath, 'utf8'))
    }
}

function _saveJob(job) {
    let jobPath = _getJobDir(job)
    if (!fs.existsSync(jobPath)) {
        fs.mkdirSync(jobPath)
    }
    fs.writeFileSync(path.join(jobPath, 'meta.json'), JSON.stringify(job))
}

function _deleteJobDir(jobId, callback) {
    let jobDir = _getJobDirById(jobId)
    rimraf(jobDir, callback)
}

function _setJobState(job, state) {
    job.state = state
    job.stateChanges = job.stateChanges || {}
    job.stateChanges[state] = new Date().toISOString()
    _saveJob(job)
}

function _appendError(job, error) {
    if (job.error) {
        job.error += '\n===========================\n' + error
    } else {
        job.error = error
    }
    job.errorState = job.state
}

function _getBasicEnv(job) {
    let user = db.users[job.user]
    let groups = user && user.groups
    return {
        DATA_ROOT: dataRoot,
        SHARED_DIR: sharedDir,
        USER_GROUPS: groups ? groups.join(' ') : '',
        JOB_NUMBER: job.id,
        JOB_DIR: _getJobDir(job)
    }
}

function _getPreparationEnv(job) {
    let env = _getBasicEnv(job)
    if (job.continueJob) {
        env.CONTINUE_JOB_NUMBER = job.continueJob
    }
    return env
}

function _prepareJob(job) {
    let env = _getPreparationEnv(job)
    _setJobState(job, jobStates.PREPARING)
    return utils.runScript('prepare.sh', env, (code, stdout, stderr) => {
        store.lockAutoRelease('jobs', () => {
            if (code == 0 && fs.existsSync(_getJobDir(job))) {
                db.schedule.push(job.id)
                _setJobState(job, jobStates.WAITING)
            } else {
                _appendError(job, 'Problem during preparation step - exit code: ' + code + '\n' + stderr)
                _setJobState(job, jobStates.DONE)
            }
        })
    })
}

function _cleanJob(job, success) {
    _setJobState(job, jobStates.CLEANING)
    utils.runScript('clean.sh', _getPreparationEnv(job), (code, stdout, stderr) => {
        store.lockAutoRelease('jobs', () => {
            if (code > 0) {
                _appendError(job, 'Problem during cleaning step - exit code: ' + code + '\n' + stderr)
            }
            _setJobState(job, jobStates.DONE)
        })
    })
}

function _getComputeEnv(job, clusterReservation) {
    let jobEnv = _getBasicEnv(job)
    jobEnv.NUM_GROUPS = clusterReservation.length
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
            jobEnv['NODE'] = node.id
            jobEnv['NUM_PORTS_PER_PROCESS_GROUP' + gIndex] = portCount
        }
    }
    return jobEnv
}

function _startJob(job, clusterReservation, callback) {
    _setJobState(job, jobStates.STARTING)
    job.clusterReservation = clusterReservation
    let jobEnv = _getComputeEnv(job, clusterReservation)
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
            EXTRA_WAIT_TIME:      Math.floor(2 * pollInterval / 1000),
            ALLOWED_CUDA_DEVICES: cudaIndices.join(',')
        }, jobEnv)
        nodesModule.runScriptOnNode(node, 'run.sh', processEnv, (code, stdout, stderr) => {
            if (code == 0) {
                let pid = 0
                stdout.split('\n').forEach(line => {
                    let [key, value] = line.split(':')
                    if (key == 'pid' && value) {
                        pid = value
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
                _appendError(job, 'Problem during startup (process ' + 
                    reservation.groupIndex + ':' + reservation.processIndex + 
                    ') - exit code: ' + code + '\n' + stderr
                )
                _setJobState(job, jobStates.STOPPING)
            }
            done()
        })
    }, () => {
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
        resources: dbjob.state >= jobStates.STARTING ? summarizeClusterReservation(dbjob.clusterReservation, true) : dbjob.clusterRequest,
        state: dbjob.state,
        since: duration,
        schedulePosition: db.schedule.indexOf(dbjob.id),
        utilComp: utilComp / utilCompCount,
        utilMem: utilMem / utilMemCount
    }
}

function _getJobDescription(jobId, user, extended) {
    let dbjob = _loadJob(jobId)
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

function _sendLog(req, res, job, logFile, stopState) {
    if (groupsModule.canAccessJob(req.user, job)) {
        res.writeHead(200, {
            'Connection': 'keep-alive',
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-cache'
        })
        req.connection.setTimeout(60 * 60 * 1000)
        let logPath = path.join(_getJobDir(job), logFile)
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
            if (job.state <= stopState) {
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
            } else {
                res.status(404).send()
            }
        }
        poll()
    } else {
        res.status(403).send()
    }
}

function _stripCredentials(url) {
    return url.replace(/\/\/.*\@/g, '//')
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
                let continueJob = _loadJob(job.continueJob)
                if (!continueJob) {
                    res.status(404).send({ message: 'The job to continue is not existing' })
                    return
                }
                if (!groupsModule.canAccessJob(req.user, continueJob)) {
                    res.status(403).send({ message: 'Continuing provided job not allowed for current user' })
                    return
                }
            }
            let simulatedReservation = reserveCluster(clusterRequest, req.user, true)
            if (simulatedReservation) {
                let dbjob = {
                    id: id,
                    user: req.user.id,
                    description: ('' + job.description).substring(0,20),
                    clusterRequest: job.clusterRequest,
                    clusterReservation: simulatedReservation,
                    continueJob: job.continueJob
                }
                if (!job.private) {
                    dbjob.groups = req.user.autoshare
                }
                if (job.origin) {
                    let visibleOrigin = _stripCredentials(job.origin)
                    dbjob.provisioning = 'Git commit ' + job.hash + ' from ' + visibleOrigin
                    if (job.diff) {
                        dbjob.provisioning += ' with ' +
                            (job.diff + '').split('\n').length + ' LoC diff'
                    }
                } else if (job.archive) {
                    dbjob.provisioning = 'Archive (' + fs.statSync(archive).size + ' bytes)'
                } else {
                    res.status(400).send({ message: 'No job data' })
                    return
                }
                _setJobState(dbjob, jobStates.NEW)
                let respond = () => {
                    db.jobs[id] = dbjob
                    res.status(200).send({ id: id })
                }
                let writeDiff = () => {
                    if (job.diff) {
                        let patchPath = path.join(_getJobDir(dbjob), 'git.patch')
                        fs.writeFile(patchPath, job.diff + '\n', err => {
                            if (err) {
                                _deleteJobDir(id)
                                res.status(500).send({ message: 'Error writing diff data' })
                            } else {
                                respond()
                            }
                        })
                    } else {
                        respond()
                    }
                }
                if (job.origin) {
                    let origin = job.origin
                    let originFilename = path.join(
                        _getJobDir(dbjob), 
                        _stripCredentials(origin) === origin ? 'public-origin.txt' : 'private-origin.txt'
                    )
                    fs.writeFile(originFilename, origin, err => {
                        if (err) {
                            _deleteJobDir(id)
                            res.status(500).send({ message: 'Error writing origin meta data file' })
                        } else {
                            fs.writeFile(path.join(_getJobDir(dbjob), 'hash.txt'), job.hash, err => {
                                if (err) {
                                    _deleteJobDir(id)
                                    res.status(500).send({ message: 'Error writing hash meta data file' })
                                } else {
                                    writeDiff()
                                }
                            })
                        }
                    })
                } else if (job.archive) {
                    fs.rename(job.archive, path.join(_getJobDir(dbjob), 'archive.tar.gz'), err => {
                        if (err) {
                            _deleteJobDir(id)
                            res.status(500).send({ message: 'Error moving archive to job directory' })
                        } else {
                            writeDiff()
                        }
                    })
                }
            } else {
                res.status(406).send({ message: 'Cluster cannot fulfill resource request' })
            }
        })
    })

    app.get('/jobs', function(req, res) {
        fs.readdir(_getJobsDir(), (err, files) => {
            if (err || !files) {
                res.status(500).send()
            } else {
                res.status(200).send(files.filter(v => !isNaN(parseInt(v, 10))))
            }
        })
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
        waiting = waiting.concat(jobs.filter(j => j.state == jobStates.NEW))
        let done = jobs.filter(j => j.state >= jobStates.CLEANING).sort((a,b) => b.id - a.id).slice(0, 20)
        res.status(200).send({
            running: running.map(j => _createJobDescription(j)),
            waiting: waiting.map(j => _createJobDescription(j)),
            done:    done   .map(j => _createJobDescription(j))
        })
    })

    app.get('/jobs/:id', function(req, res) {
        let job = _getJobDescription(req.params.id, req.user, true)
        if (job) {
            res.status(200).send(job)
        } else {
            res.status(404).send()
        }
    })

    app.get('/jobs/:id/targz', function(req, res) {
        let dbjob = _loadJob(req.params.id)
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

    app.get('/jobs/:id/preplog', function(req, res) {
        let dbjob = _loadJob(req.params.id)
        if (dbjob) {
            _sendLog(req, res, dbjob, 'preparation.log', jobStates.PREPARING)
        } else {
            res.status(404).send()
        }
    })

    app.get('/jobs/:id/groups/:group/processes/:proc/log', function(req, res) {
        let dbjob = _loadJob(req.params.id)
        let group = Number(req.params.group)
        let proc = Number(req.params.proc)
        if (dbjob &&
            dbjob.clusterReservation &&
            group < dbjob.clusterReservation.length &&
            proc < dbjob.clusterReservation[group].length
        ) {
            _sendLog(req, res, dbjob, 'process_' + group + '_' + proc + '.log', jobStates.STOPPING)
        } else {
            res.status(404).send()
        }
    })

    app.post('/jobs/:id/stop', function(req, res) {
        store.lockAutoRelease('jobs', function() {
            let dbjob = _loadJob(req.params.id)
            if (dbjob) {
                if (groupsModule.canAccessJob(req.user, dbjob)) {
                    if (dbjob.state <= jobStates.RUNNING) {
                        let scheduleIndex = db.schedule.indexOf(dbjob.id)
                        if (scheduleIndex >= 0) {
                            db.schedule.splice(scheduleIndex, 1)
                        }
                        _setJobState(dbjob, jobStates.STOPPING)
                        res.status(200).send()
                    } else {
                        res.status(412).send({ message: 'Only jobs before or in running state can be stopped' })
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
            var dbjob = _loadJob(id)
            if (dbjob) {
                if (groupsModule.canAccessJob(req.user, dbjob)) {
                    if (dbjob.state >= jobStates.DONE) {
                        if (db.jobs[id]) {
                            delete db.jobs[id]
                        }
                        _deleteJobDir(id, err => {
                            if (err) {
                                res.status(500).send()
                            } else {
                                res.status(200).send()
                            }
                        })
                    } else {
                        res.status(412).send({ message: 'Only done or archived jobs can be deleted' })
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

function _resimulateReservations() {
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
                _appendError(job, 'Cluster cannot fulfill resource request anymore')
                _setJobState(job, jobStates.DONE)
                let index = db.schedule.indexOf(job.id)
                if (index >= 0) {
                    db.schedule.splice(index, 1)
                }
            }
        })
    }
}

groupsModule.on('restricted', _resimulateReservations)

groupsModule.on('changed', (type, entity) => {
    if (type == 'job' && entity) {
        _saveJob(entity)
    }
})

var realProcesses = {}
var utilization = {}

nodesModule.on('data', (nodeId, nodePids, nodeUtilization) => {
    realProcesses[nodeId] = nodePids
    utilization[nodeId] = nodeUtilization
})

nodesModule.on('state', (nodeId, nodeState) => {
    if (nodeState == nodesModule.nodeStates.OFFLINE) {
        delete realProcesses[nodeId]
        delete utilization[nodeId]
        _resimulateReservations()
    }
})

exports.tick = function() {
    if (Object.keys(realProcesses).length < Object.keys(db.nodes).length) {
        console.log('Waiting for feedback from all nodes...')
        setTimeout(exports.tick, pollInterval)
        return
    }
    for(let worker of Object.keys(cluster.workers).map(k => cluster.workers[k])) {
        worker.send({ utilization: utilization })
    }
    store.lockAsyncRelease('jobs', release => {
        let goon = () => {
            release()
            setTimeout(exports.tick, pollInterval)
        }
        let processes = _getJobProcesses()
        let toStop = []
        for(let jobId of Object.keys(processes)) {
            let toStart = 0
            let job = db.jobs[jobId]
            if (job.state < jobStates.STARTING || job.state > jobStates.STOPPING) {
                continue
            }
            let toStopForJob = []
            let jobProcesses = processes[jobId]
            for(let nodeId of Object.keys(jobProcesses)) {
                let nodeProcesses = jobProcesses[nodeId]
                let realNodeProcesses = realProcesses[nodeId]
                if (realNodeProcesses) {
                    for(let pid of Object.keys(nodeProcesses)) {
                        if (job.state == jobStates.STARTING) {
                            if (!realNodeProcesses[pid]) {
                                toStart++
                            }
                        } else {
                            if (realNodeProcesses[pid]) {
                                toStopForJob.push({ node: nodeId, pid: pid })
                            } else {
                                _setJobState(job, jobStates.STOPPING)
                                _freeProcess(nodeId, pid)
                            }
                        }
                    }
                } else if (job.state == jobStates.STARTING) {
                    toStart += nodeProcesses.length
                } else {
                    _setJobState(job, jobStates.STOPPING)
                }
            }
            if (job.state == jobStates.STOPPING && toStopForJob.length > 0) {
                toStop = toStop.concat(toStopForJob)
            } else if (job.state == jobStates.STARTING && toStart == 0) {
                _setJobState(job, jobStates.RUNNING)
            }
        }
        utils.runForEach(toStop, (proc, done) => {
            nodesModule.runScriptOnNode(db.nodes[proc.node], 'kill.sh', { PID: proc.pid }, (code, stdout, stderr) => {
                if (code == 0) {
                    console.log('Ended PID: ' + proc.pid)
                } else {
                    console.log('Problem ending PID: ' + proc.pid)
                }
                done()
            })
        }, () => {
            for(let job of Object.keys(db.jobs).map(k => db.jobs[k])) {
                let stateTime = new Date(job.stateChanges[job.state]).getTime()
                if (
                    job.state == jobStates.DONE && 
                    stateTime + keepDoneDuration < Date.now()
                ) {
                    _setJobState(job, jobStates.ARCHIVED)
                    delete db.jobs[job.id]
                } else if (
                    job.state == jobStates.NEW && 
                    Object.keys(preparations).length < maxParallelPrep
                ) {
                    let p = _prepareJob(job)
                    preparations[job.id] = p
                    p.on('exit', () => delete preparations[job.id])
                } else if (
                    job.state == jobStates.PREPARING &&
                    stateTime + maxPrepDuration < Date.now()
                ) {
                    _appendError(job, 'Job exceeded max preparation time')
                    _setJobState(job, jobStates.STOPPING)
                } else if (
                    job.state == jobStates.STARTING &&
                    stateTime + maxStartDuration < Date.now()
                ) {
                    _appendError(job, 'Job exceeded max startup time')
                    _setJobState(job, jobStates.STOPPING)
                }
                if (
                    job.state == jobStates.STOPPING &&
                    preparations.hasOwnProperty(job.id)
                ) {
                    preparations[job.id].kill()
                    _setJobState(job, jobStates.DONE)
                }
            }
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
}