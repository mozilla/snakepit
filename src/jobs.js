const fs = require('fs-extra')
const path = require('path')
const zlib = require('zlib')
const tar = require('tar-fs')
const ndir = require('node-dir')
const async = require('async')
const fslib = require('httpfslib')

const log = require('./logger.js')
const store = require('./store.js')
const utils = require('./utils.js')
const jobfs = require('./jobfs.js')
const config = require('./config.js')
const nodesModule = require('./nodes.js')
const groupsModule = require('./groups.js')
const parseClusterRequest = require('./clusterParser.js').parse
const reservations = require('./reservations.js')

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

var jobStateNames = {}
for(let name of Object.keys(jobStates)) {
    jobStateNames[jobStates[name]] = name
}

exports.jobStates = jobStates

var db = store.root
var utilization = {}
var preparations = {}

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
            appendError(job, 'Job was interrupted during preparation')
            cleanJob(job)
        } else if (job.state == jobStates.CLEANING) {
            cleanJob(job)
        }
    }
    if (!db.schedule) {
        db.schedule = []
    }
}

function appendError(job, error) {
    if (job.error) {
        job.error += '\n===========================\n' + error
    } else {
        job.error = error
    }
    job.errorState = job.state
}

function getBasicEnv(job) {
    return {
        JOB_NUMBER: job.id,
        DATA_ROOT:  config.dataRoot,
        JOB_DIR:    nodesModule.getPitDir(job.id)
    }
}

function getPreparationEnv(job) {
    let env = getBasicEnv(job)
    if (job.continueJob) {
        env.CONTINUE_JOB_NUMBER = job.continueJob
    }
    return env
}

function setJobState(job, state) {
    job.state = state
    job.stateChanges = job.stateChanges || {}
    job.stateChanges[state] = new Date().toISOString()
    saveJob(job)
}

function loadJob (jobId) {
    let job = db.jobs[jobId]
    if (job) {
        return job
    }
    let jobPath = path.join(nodesModule.getPitDir(jobId), 'meta.json')
    if (fs.existsSync(jobPath)) {
        return JSON.parse(fs.readFileSync(jobPath, 'utf8'))
    }
}

function saveJob (job) {
    fs.writeFileSync(path.join(nodesModule.getPitDir(job.id), 'meta.json'), JSON.stringify(job))
}

function prepareJob(job) {
    let env = getPreparationEnv(job)
    if (job.origin) {
        Object.assign(env, {
            ORIGIN: job.origin,
            HASH:   job.hash
        })
    } else {
        env.ARCHIVE = job.archive
    }
    setJobState(job, jobStates.PREPARING)
    return utils.runScript('prepare.sh', env, (code, stdout, stderr) => {
        store.lockAutoRelease('jobs', () => {
            if (code == 0 && fs.existsSync(nodesModule.getPitDir(job.id)) && job.state == jobStates.PREPARING) {
                db.schedule.push(job.id)
                setJobState(job, jobStates.WAITING)
            } else {
                if (job.state != jobStates.STOPPING) {
                    appendError(job, 'Problem during preparation step - exit code: ' + code + '\n' + stdout + '\n' + stderr)  
                }
                setJobState(job, jobStates.DONE)
            }
        })
    })
}

function startJob (job, clusterReservation, callback) {
    setJobState(job, jobStates.STARTING)
    job.clusterReservation = clusterReservation
    let jobEnv = getBasicEnv(job)
    
    jobEnv.JOB_DIR = '/data/pit'
    jobEnv.SRC_DIR = jobEnv.WORK_DIR = '/data/pit/src'
    fs.mkdirpSync(path.join(config.dataRoot, 'shared'))
    fs.mkdirpSync(path.join(config.dataRoot, 'home', job.user))
    let shares = {
        'shared': path.join(config.mountRoot, 'shared'),
        'home':   path.join(config.mountRoot, 'home', job.user)
    }
    jobEnv.DATA_ROOT = '/data'
    jobEnv.SHARED_DIR = '/data/shared'
    jobEnv.USER_DIR = '/data/home'
    for (let group of groupsModule.getGroups(db.users[job.user])) {
        fs.mkdirpSync(path.join(config.dataRoot, 'groups', group))
        shares['group-' + group] = path.join(config.mountRoot, 'groups', group)
        jobEnv[group.toUpperCase() + '_GROUP_DIR'] = '/data/group-' + group
    }

    let workers = []
    jobEnv.NUM_GROUPS = clusterReservation.length
    for(let gIndex = 0; gIndex < clusterReservation.length; gIndex++) {
        let groupReservation = clusterReservation[gIndex]
        jobEnv['NUM_PROCESSES_GROUP' + gIndex] = groupReservation.length
        for(let pIndex = 0; pIndex < groupReservation.length; pIndex++) {
            let processReservation = groupReservation[pIndex]
            let node = db.nodes[processReservation.node]
            jobEnv['HOST_GROUP' + gIndex + '_PROCESS' + pIndex] = 
                nodesModule.getWorkerHost(job.id, node, workers.length)
            let gpus = {}
            for(let resourceId of Object.keys(processReservation.resources)) {
                let resource = processReservation.resources[resourceId]
                if (resource.type == 'cuda') {
                    gpus['gpu' + resource.index] = {
                        type:  'gpu',
                        id:    '' + resource.index
                    }
                }
            }
            workers.push({
                node: node,
                options: { devices: gpus },
                env: Object.assign({
                    GROUP_INDEX:   processReservation.groupIndex,
                    PROCESS_INDEX: processReservation.processIndex
                }, jobEnv),
                script: job.script
            })
        }
    }
    nodesModule.startPit(job.id, shares, workers).then(() => {
        reservations.fulfillReservation(clusterReservation, job.id)
        setJobState(job, jobStates.RUNNING)
        callback()
    }).catch(err => {
        log.debug('START PROBLEM', err)
        appendError(job, 'Problem while starting: ' + err.toString())
        cleanJob(job)
        callback()
    })
}

function stopJob (job) {
    let scheduleIndex = db.schedule.indexOf(job.id)
    if (scheduleIndex >= 0) {
        db.schedule.splice(scheduleIndex, 1)
    }
    let finalizeJob = err => {
        if (err) {
            appendError(job, 'Problem while stopping: ' + err.toString())
        }
        cleanJob(job)
    }
    if (job.state == jobStates.PREPARING && preparations[job.id]) {
        setJobState(job, jobStates.STOPPING)
        preparations[job.id].kill()
        delete preparations[job.id]
        finalizeJob()
    } else if (job.state == jobStates.RUNNING) {
        setJobState(job, jobStates.STOPPING)
        nodesModule.stopPit(job.id).then(finalizeJob).catch(finalizeJob)
    }
}

function cleanJob(job) {
    setJobState(job, jobStates.CLEANING)
    utils.runScript('clean.sh', getPreparationEnv(job), (code, stdout, stderr) => {
        store.lockAutoRelease('jobs', () => {
            if (code > 0) {
                appendError(job, 'Problem during cleaning step - exit code: ' + code + '\n' + stderr)
            }
            setJobState(job, jobStates.DONE)
        })
    })
}

function createJobDescription(dbjob) {
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
        id:               dbjob.id,
        description:      dbjob.description,
        user:             dbjob.user,
        groups:           dbjob.groups,
        resources:        dbjob.state >= jobStates.STARTING ? 
                              reservations.summarizeClusterReservation(dbjob.clusterReservation, true) : 
                              dbjob.clusterRequest,
        state:            dbjob.state,
        since:            duration,
        schedulePosition: db.schedule.indexOf(dbjob.id),
        utilComp:         utilComp / utilCompCount,
        utilMem:          utilMem / utilMemCount
    }
}

function getJobDescription(jobId, user, extended) {
    let dbjob = loadJob(jobId)
    let job = dbjob ? createJobDescription(dbjob) : null
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

function sendLog(req, res, job) {
    res.writeHead(200, {
        'Connection': 'keep-alive',
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-cache'
    })
    req.connection.setTimeout(60 * 60 * 1000)
    let interval = config.pollInterval / 10
    let logPath = path.join(nodesModule.getPitDir(job.id), 'pit.log')
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
        if (job.state <= jobStates.STOPPING) {
            if (fs.existsSync(logPath)) {
                fs.stat(logPath, (err, stats) => {
                    if (!err && stats.size > written) {
                        writeStream(() => setTimeout(poll, interval))
                    } else  {
                        setTimeout(poll, interval)
                    }
                })
            } else {
                setTimeout(poll, interval)
            }
        } else if (fs.existsSync(logPath)) {
            writeStream(res.end.bind(res))
        } else {
            res.status(404).send()
        }
    }
    poll()
}

function handleJobAndPath(req, res, cb) {
    var dbjob = loadJob(req.params.id)
    if (dbjob) {
        if (groupsModule.canAccessJob(req.user, dbjob)) {
            let jobDir = nodesModule.getPitDir(dbjob.id)
            let newPath = path.resolve(jobDir, req.params[0] || '')
            if (newPath.startsWith(jobDir)) {
                cb(dbjob, newPath)
            } else {
                res.status(404).send()
            }
        } else {
            res.status(403).send()
        }
    } else {
        res.status(404).send()
    }
}

exports.initApp = function(app) {
    app.post('/jobs', function(req, res) {
        let job = req.body
        var clusterRequest
        try {
            clusterRequest = parseClusterRequest(job.clusterRequest)
        } catch (ex) {
            res.status(400).send({ message: 'Problem parsing allocation' })
            return
        }
        if (job.continueJob) {
            let continueJob = loadJob(job.continueJob)
            if (!continueJob) {
                res.status(404).send({ message: 'The job to continue is not existing' })
                return
            }
            if (!groupsModule.canAccessJob(req.user, continueJob)) {
                res.status(403).send({ message: 'Continuing provided job not allowed for current user' })
                return
            }
        }
        let simulatedReservation = reservations.reserveCluster(clusterRequest, req.user, true)
        if (simulatedReservation) {
            nodesModule.createPit().then(id => {
                store.lockAutoRelease('jobs', function() {
                    let dbjob = {
                        id:                 id,
                        user:               req.user.id,
                        description:        ('' + job.description).substring(0,20),
                        clusterRequest:     job.clusterRequest,
                        clusterReservation: simulatedReservation,
                        script:             job.script || 'if [ -f .compute ]; then bash .compute; fi',
                        continueJob:        job.continueJob,
                        origin:             job.origin,
                        hash:               job.hash,
                        archive:            job.archive
                    }
                    if (!job.private) {
                        dbjob.groups = req.user.autoshare
                    }
                    if (job.origin) {
                        dbjob.provisioning = 'Git commit ' + job.hash + ' from ' + job.origin
                        if (job.diff) {
                            dbjob.provisioning += ' with ' +
                                (job.diff + '').split('\n').length + ' LoC diff'
                        }
                    } else if (job.archive) {
                        dbjob.provisioning = 'Archive (' + fs.statSync(job.archive).size + ' bytes)'
                    }
                    setJobState(dbjob, jobStates.NEW)
    
                    var files = {}
                    if (job.diff) {
                        files['git.patch'] = job.diff + '\n'
                    }
                    let jobDir = nodesModule.getPitDir(dbjob.id)
                    async.forEachOf(files, (content, file, done) => {
                        let p = path.join(jobDir, file)
                        fs.writeFile(p, content, err => {
                            if (err) {
                                jobfs.deleteJobDir(id)
                                done('Error on persisting ' + file)
                            } else {
                                done()
                            }
                        })
                    }, err => {
                        if (err) {
                            res.status(500).send({ message: err })
                        } else {
                            db.jobs[id] = dbjob
                            res.status(200).send({ id: id })
                        }
                    })
                })
            }).catch(err => res.status(500).send({ message: 'Cannot create pit directory' }))
        } else {
            res.status(406).send({ message: 'Cluster cannot fulfill resource request' })
        }
    })

    app.get('/jobs', function(req, res) {
        fs.readdir(path.join(config.dataRoot, 'pits'), (err, files) => {
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
            running: running.map(j => createJobDescription(j)),
            waiting: waiting.map(j => createJobDescription(j)),
            done:    done   .map(j => createJobDescription(j))
        })
    })

    app.get('/jobs/:id', function(req, res) {
        let job = getJobDescription(req.params.id, req.user, true)
        if (job) {
            res.status(200).send(job)
        } else {
            res.status(404).send()
        }
    })

    app.get('/jobs/:id/targz', function(req, res) {
        let dbjob = loadJob(req.params.id)
        if (dbjob) {
            if (groupsModule.canAccessJob(req.user, dbjob)) {
                let jobdir = nodesModule.getPitDir(dbjob.id)
                res.status(200).type('tar.gz')
                tar.pack(jobdir).pipe(zlib.createGzip()).pipe(res)
            } else {
                res.status(403).send()
            }
        } else {
            res.status(404).send()
        }
    })

    app.get('/jobs/:id/stats/(*)?', function(req, res) {
        handleJobAndPath(req, res, (dbjob, resource) => {
            fs.stat(resource, (err, stats) => {
                if (err || !(stats.isDirectory() || stats.isFile())) {
                    res.status(404).send()
                } else {
                    res.send({
                        isFile: stats.isFile(),
                        size:   stats.size,
                        mtime:  stats.mtime,
                        atime:  stats.atime,
                        ctime:  stats.ctime
                    })
                }
            })
        })
    })

    app.get('/jobs/:id/content/(*)?', function(req, res) {
        handleJobAndPath(req, res, (dbjob, resource) => {
            fs.stat(resource, (err, stats) => {
                if (err || !(stats.isDirectory() || stats.isFile())) {
                    res.status(404).send()
                } else {
                    if (stats.isDirectory()) {
                        ndir.files(resource, 'all', (err, paths) => {
                            if (err) {
                                res.status(500).send()
                            } else {
                                res.send({ dirs: paths.dirs, files: paths.files })
                            }
                        }, { shortName: true, recursive: false })
                    } else {
                        res.writeHead(200, {
                            'Content-Type': 'application/octet-stream',
                            'Content-Length': stats.size
                        })
                        fs.createReadStream(resource).pipe(res)
                    }
                }
            })
        })
    })

    app.get('/jobs/:id/log', function(req, res) {
        let dbjob = loadJob(req.params.id)
        if (dbjob) {
            if (groupsModule.canAccessJob(req.user, dbjob)) {
                sendLog(req, res, dbjob)
            } else {
                res.status(403).send()
            }
        } else {
            res.status(404).send()
        }
    })

    app.post('/jobs/:id/fs', function(req, res) {
        var dbjob = loadJob(req.params.id)
        if (dbjob) {
            if (groupsModule.canAccessJob(req.user, dbjob)) {
                let chunks = []
                req.on('data', chunk => chunks.push(chunk));
                req.on('end', () => fslib.serve(
                    fslib.readOnly(fslib.real(nodesModule.getPitDir(dbjob.id))), 
                    Buffer.concat(chunks), 
                    result => res.send(result), config.debugJobFS)
                )
            } else {
                res.status(403).send()
            }
        } else {
            res.status(404).send()
        }
    })

    app.post('/jobs/:id/stop', function(req, res) {
        store.lockAutoRelease('jobs', function() {
            let dbjob = loadJob(req.params.id)
            if (dbjob) {
                if (groupsModule.canAccessJob(req.user, dbjob)) {
                    if (dbjob.state <= jobStates.RUNNING) {
                        stopJob(dbjob)
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
            var dbjob = loadJob(id)
            if (dbjob) {
                if (groupsModule.canAccessJob(req.user, dbjob)) {
                    if (dbjob.state >= jobStates.DONE) {
                        if (db.jobs[id]) {
                            delete db.jobs[id]
                        }
                        nodesModule.deletePit(id)
                            .then(() => res.status(200).send())
                            .catch(err => res.status(500).send())
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

function resimulateReservations() {
    let jobs = []
    for(let job of Object.keys(db.jobs).map(k => db.jobs[k])) {
        if (job.state >= jobStates.PREPARING && job.state <= jobStates.WAITING) {
            let clusterRequest = parseClusterRequest(job.clusterRequest)
            let clusterReservation = reservations.reserveCluster(clusterRequest, db.users[job.user], true)
            if (!clusterReservation) {
                jobs.push(job)
            }
        }
    }
    if (jobs.length > 0) {
        store.lockAutoRelease('jobs', function() {
            for (let job of jobs) {
                appendError(job, 'Cluster cannot fulfill resource request anymore')
                setJobState(job, jobStates.DONE)
                let index = db.schedule.indexOf(job.id)
                if (index >= 0) {
                    db.schedule.splice(index, 1)
                }
            }
        })
    }
}
groupsModule.on('restricted', resimulateReservations)

groupsModule.on('changed', (type, entity) => {
    if (type == 'job' && entity) {
        saveJob(entity)
    }
})

/*
nodesModule.on('pitStarting', pitId => {
    let job = db.jobs[pitId]
    if (job) {
        setJobState(job, jobStates.STARTING)
    }
})
*/

nodesModule.on('pitStopping', pitId => {
    let job = db.jobs[pitId]
    if (job) {
        setJobState(job, jobStates.STOPPING)
    }
})

nodesModule.on('pitStopped', pitId => {
    let job = db.jobs[pitId]
    if (job) {
        cleanJob(job)
    }
})

nodesModule.on('pitReport', pits => {
    pits = pits.reduce((hashMap, obj) => {
        hashMap[obj] = true
        return hashMap
    }, {})
    for (let jobId of Object.keys(db.jobs)) {
        let job = db.jobs[jobId]
        if (job.state == jobStates.RUNNING && !pits[jobId]) {
            stopJob(job)
        }
    }
})

exports.tick = function() {
    store.lockAsyncRelease('jobs', release => {
        let goon = () => {
            release()
            setTimeout(exports.tick, config.pollInterval)
        }
        let running = {}
        for(let job of Object.keys(db.jobs).map(k => db.jobs[k])) {
            let stateTime = new Date(job.stateChanges[job.state]).getTime()
            if (
                job.state == jobStates.NEW && 
                Object.keys(preparations).length < config.maxParallelPrep
            ) {
                preparations[job.id] = prepareJob(job)
            } else if (
                job.state == jobStates.DONE && 
                stateTime + config.keepDoneDuration < Date.now()
            ) {
                setJobState(job, jobStates.ARCHIVED)
                delete db.jobs[job.id]
            } else if (job.state >= jobStates.STARTING && job.state <= jobStates.STOPPING) {
                running[job.id] = job
            }
        }
        for (let node of Object.keys(db.nodes).map(k => db.nodes[k])) {
            for (let resource of node.resources || []) {
                if (resource.job && !running[resource.job]) {
                    delete resource.job
                }
            }   
        }
        for(let jobId of Object.keys(preparations)) {
            let job = db.jobs[jobId]
            if (job && job.state == jobStates.PREPARING) {
                if (new Date(job.stateChanges[job.state]).getTime() + config.maxPrepDuration < Date.now()) {
                    appendError(job, 'Job exceeded max preparation time')
                    stopJob(job)
                }
            } else {
                delete preparations[jobId]
                if (!job) {
                    console.error('Removed preparation process for orphan job ' + jobId)
                }
            }
        }
        if (db.schedule.length > 0) {
            let job = db.jobs[db.schedule[0]]
            if (job) {
                let clusterRequest = parseClusterRequest(job.clusterRequest)
                let clusterReservation = reservations.reserveCluster(clusterRequest, db.users[job.user], false)
                log.debug('STARTING SCHEDULED JOB', job.id, job.user, JSON.stringify(clusterRequest), clusterReservation)
                if (clusterReservation) {
                    db.schedule.shift()
                    startJob(job, clusterReservation, goon)
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
}