const zlib = require('zlib')
const tar = require('tar-fs')
const ndir = require('node-dir')
const async = require('async')
const Router = require('express-promise-router')

const fslib = require('../utils/httpfs.js')
const clusterEvents = require('../utils/clusterEvents.js')

var router = module.exports = new Router()

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

router.post('/', async (req, res) => {
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

function targetGroup (req, res, next) {
    req.targetGroup = Group.findById(req.params.group)
    req.targetGroup ? next() : res.status(404).send()
}

router.put('/:id/groups/:group', targetGroup, async (req, res) => {
    await req.targetJob.addGroup(req.targetGroup)
    res.send()
})

router.delete('/:id/groups/:group', targetGroup, async (req, res) => {
    await req.targetJob.removeGroup(req.targetGroup)
    res.send()
    clusterEvents.emit('restricted')
})

router.get('/', async (req, res) => {
    fs.readdir('/data/pits', (err, files) => {
        if (err || !files) {
            res.status(500).send()
        } else {
            res.status(200).send(files.filter(v => !isNaN(parseInt(v, 10))))
        }
    })
})

router.get('/status', async (req, res) => {
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

router.get('/:id', async (req, res) => {
    let job = getJobDescription(req.params.id, req.user, true)
    if (job) {
        res.status(200).send(job)
    } else {
        res.status(404).send()
    }
})

router.get('/:id/targz', async (req, res) => {
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

router.get('/:id/stats/(*)?', async (req, res) => {
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

router.get('/:id/content/(*)?', async (req, res) => {
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

router.get('/:id/log', async (req, res) => {
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

router.post('/:id/fs', async (req, res) => {
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

router.post('/:id/stop', async (req, res) => {
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

router.delete('/:id', async (req, res) => {
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
