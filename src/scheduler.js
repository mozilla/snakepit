const fs = require('fs-extra')
const path = require('path')

const log = require('./utils/logger.js')
const clusterEvents = require('./utils/clusterEvents.js')
const config = require('./config.js')
const reservations = require('./reservations.js')
const parseClusterRequest = require('./clusterParser.js').parse
const Job = require('./models/Job-model.js')

const jobStates = Job.jobStates

var exports = module.exports = {}

var preparations = {}

function getBasicEnv(job) {
    return {
        JOB_NUMBER: job.id,
        DATA_ROOT:  '/data',
        JOB_DIR:    job.getJobDir()
    }
}

function getPreparationEnv(job) {
    let env = getBasicEnv(job)
    if (job.continues) {
        env.CONTINUE_JOB_NUMBER = job.continues
    }
    return env
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
    job.setState(jobStates.PREPARING)
    return utils.runScript('prepare.sh', env, (code, stdout, stderr) => {
        store.lockAutoRelease('jobs', () => {
            if (code == 0 && fs.existsSync(Pit.getDir(job.id)) && job.state == jobStates.PREPARING) {
                db.schedule.push(job.id)
                job.setState(jobStates.WAITING)
            } else {
                if (job.state != jobStates.STOPPING) {
                    appendError(job, 'Problem during preparation step - exit code: ' + code + '\n' + stdout + '\n' + stderr)  
                }
                job.setState(jobStates.DONE)
            }
        })
    })
}

function startJob (job, clusterReservation, callback) {
    job.setState(jobStates.STARTING)
    job.clusterReservation = clusterReservation
    let jobEnv = getBasicEnv(job)
    
    jobEnv.JOB_DIR = '/data/rw/pit'
    jobEnv.SRC_DIR = jobEnv.WORK_DIR = '/data/rw/pit/src'
    fs.mkdirpSync('/data/shared')
    fs.mkdirpSync('/data/home/' + job.user)
    let shares = {
        '/ro/shared':    path.join(config.mountRoot, 'shared'),
        '/data/rw/home': path.join(config.mountRoot, 'home', job.user)
    }
    jobEnv.DATA_ROOT = '/data'
    jobEnv.SHARED_DIR = '/data/ro/shared'
    jobEnv.USER_DIR = '/data/rw/home'
    for (let group of groupsModule.getGroups(db.users[job.user])) {
        fs.mkdirpSync('/data/groups/' + group)
        shares['/data/rw/group-' + group] = path.join(config.mountRoot, 'groups', group)
        jobEnv[group.toUpperCase() + '_GROUP_DIR'] = '/data/rw/group-' + group
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
        job.setState(jobStates.RUNNING)
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
        job.setState(jobStates.STOPPING)
        preparations[job.id].kill()
        delete preparations[job.id]
        finalizeJob()
    } else if (job.state == jobStates.RUNNING) {
        job.setState(jobStates.STOPPING)
        nodesModule.stopPit(job.id).then(finalizeJob).catch(finalizeJob)
    }
}

async function cleanJob(job) {
    await job.setState(jobStates.CLEANING)
    utils.runScript('clean.sh', getPreparationEnv(job), async (code, stdout, stderr) => {
        await job.setState(jobStates.DONE, code > 0 ? ('Problem during cleaning step - exit code: ' + code + '\n' + stderr) : undefined)
    })
}

function resimulateReservations() {
    /*
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
                job.setState(jobStates.DONE)
                let index = db.schedule.indexOf(job.id)
                if (index >= 0) {
                    db.schedule.splice(index, 1)
                }
            }
        })
    }
    */
}

clusterEvents.on('restricted', resimulateReservations)

/*
clusterEvents.on('pitStarting', pitId => {
    let job = db.jobs[pitId]
    if (job) {
        job.setState(jobStates.STARTING)
    }
})
*/

clusterEvents.on('pitStopping', async pitId => {
    let job = await Job.findByPk(pitId)
    if (job) {
        await job.setState(jobStates.STOPPING)
    }
})

clusterEvents.on('pitStopped', async pitId => {
    let job = await Job.findByPk(pitId)
    if (job) {
        await cleanJob(job)
    }
})

clusterEvents.on('pitReport', pits => {
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

exports.startup = function () {
    for (let jobId of Object.keys(db.jobs)) {
        let job = db.jobs[jobId]
        if (job.state == jobStates.PREPARING) {
            appendError(job, 'Job was interrupted during preparation')
            cleanJob(job)
        } else if (job.state == jobStates.CLEANING) {
            cleanJob(job)
        }
    }
}

exports.tick = function() {
    /*
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
                job.setState(jobStates.ARCHIVED)
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
    */
}