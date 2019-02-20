const fs = require('fs-extra')
const path = require('path')
const log = require('./utils/logger.js')
const { to } = require('./utils/async.js')
const { runScript } = require('./utils/scripts.js')
const clusterEvents = require('./utils/clusterEvents.js')
const config = require('./config.js')
const pitRunner = require('./pitRunner.js')
const reservations = require('./reservations.js')
const Job = require('./models/Job-model.js')
const Group = require('./models/Group-model.js')


const jobStates = Job.jobStates

var exports = module.exports = {}

var preparations = {}

function getBasicEnv (job) {
    return {
        JOB_NUMBER: job.id,
        DATA_ROOT:  '/data',
        JOB_DIR:    job.getDir()
    }
}

function getPreparationEnv (job) {
    let env = getBasicEnv(job)
    if (job.continues) {
        env.CONTINUE_JOB_NUMBER = job.continues
    }
    return env
}

async function prepareJob (job) {
    let env = getPreparationEnv(job)
    await job.setState(jobStates.PREPARING)
    preparations[job.id] = runScript('prepare.sh', env, async (code, stdout, stderr) => {
        await job.reload()
        if (code == 0 && job.state == jobStates.PREPARING) {
            await job.setState(jobStates.WAITING)
        } else {
            await cleanJob(
                job,
                job.state != jobStates.STOPPING ?
                    'Problem during preparation step' :
                    undefined
            )
        }
    })
}

function stopPreparation (jobId) {
    if (preparations[jobId]) {
        let pp = preparations[jobId]
        delete preparations[jobId]
        pp.kill('SIGINT')
    }
}

async function startJob (job) {
    try {
        await job.setState(jobStates.STARTING)
        let user = await job.getUser()
        if (!user) {
            throw new Error("User not existing")
        }
        let jobEnv = getBasicEnv(job)
        
        jobEnv.JOB_DIR = '/data/rw/pit'
        jobEnv.SRC_DIR = jobEnv.WORK_DIR = '/data/rw/pit/src'
        let shares = {
            '/ro/shared':    path.join(config.mountRoot, 'shared'),
            '/data/rw/home': user.getDirExternal()
        }
        jobEnv.DATA_ROOT = '/data'
        jobEnv.SHARED_DIR = '/data/ro/shared'
        jobEnv.USER_DIR = '/data/rw/home'
        for (let ug of (await user.getUsergroups())) {
            shares['/data/rw/group-' + ug.groupId] = Group.getDirExternal(ug.groupId)
            jobEnv[ug.groupId.toUpperCase() + '_GROUP_DIR'] = '/data/rw/group-' + ug.groupId
        }

        if (config.workerEnv) {
            for(let ev of Object.keys(config.workerEnv)) {
                jobEnv[ev] = config.workerEnv[ev]
            }
        }

        let workers = []
        let processGroups = await job.getProcessgroups()
        jobEnv.NUM_GROUPS = processGroups.length
        for(let processGroup of processGroups) {
            let processes = await processGroup.getProcesses()
            jobEnv['NUM_PROCESSES_GROUP' + processGroup.index] = processes.length
            for(let jobProcess of processes) {
                let node = await jobProcess.getNode()
                jobEnv['HOST_GROUP' + processGroup.index + '_PROCESS' + jobProcess.index] = 
                    pitRunner.getWorkerHost(node.id, job.id, workers.length)
                let gpus = {}
                let allocations = await jobProcess.getAllocations()
                for(let allocation of allocations) {
                    let resource = await allocation.getResource()
                    if (resource.type == 'cuda') {
                        gpus['gpu' + (resource.index + 1)] = {
                            type:  'gpu',
                            id:    '' + (resource.index + 1)
                        }
                    }
                }
                workers.push({
                    node:    node,
                    options: { devices: gpus },
                    env:     Object.assign({
                                 GROUP_INDEX:   processGroup.index,
                                 PROCESS_INDEX: jobProcess.index
                             }, jobEnv) 
                })
            }
        }
        await pitRunner.startPit(job.id, shares, workers)
        await job.setState(jobStates.RUNNING)
    } catch (ex) {
        log.error('Problem starting job', job.id, ex)
        await cleanJob(job, 'Problem during startup: ' + ex.toString())
    }
}

async function stopJob (job, reason) {
    await job.setState(jobStates.STOPPING, reason)
}
exports.stopJob = stopJob

async function cleanJob (job, reason) {
    await job.setState(jobStates.CLEANING, reason)
    let [err, results] = await to(pitRunner.getResults(job.id))
    if (results) {
        let workerIndex = 0
        let processGroups = await job.getProcessgroups()
        for(let processGroup of processGroups) {
            let processes = await processGroup.getProcesses()
            for(let jobProcess of processes) {
                let workerResult = results[workerIndex]
                workerIndex++
                if (workerResult) {
                    jobProcess.result = workerResult.result
                    jobProcess.status = workerResult.status
                    await jobProcess.save()
                }
            }
        }
    }
    runScript('clean.sh', getPreparationEnv(job), async (code, stdout, stderr) => {
        await job.setState(
            jobStates.DONE, code > 0 ?
                ('Problem during cleaning step - exit code: ' + code + '\n' + stderr) :
                undefined
        )
    })
}

async function tick () {
    log.debug('Tick...')
    for(let jobId of Object.keys(preparations)) {
        let job = await Job.findByPk(jobId)
        if (job) {
            if (job.state == jobStates.PREPARING) {
                if (job.since.getTime() + config.maxPrepDuration < Date.now()) {
                    log.debug('Preparation timeout for job', jobId)
                    await stopJob(job, 'Job exceeded max preparation time')
                }
            } else if (job.state == jobStates.STOPPING) {
                stopPreparation(job.id)
            }
        } else {
            stopPreparation(jobId)
            log.error('Stopped orphan preparation process for job', jobId)
        }
    }
    for(let job of (await Job.findAll({ where: { state: jobStates.NEW } }))) {
        if (Object.keys(preparations).length < config.maxParallelPrep) {
            log.debug('Preparing job', job.id)
            await prepareJob(job)
        } else {
            break
        }
    }
    let job = await Job.findOne({ where: { state: jobStates.WAITING }, order: ['rank'] })
    if (job) {
        log.debug('Trying to allocate job', job.id)
        if (await reservations.tryAllocate(job)) {
            log.debug('Starting job', job.id)
            await startJob(job)
        }
    }
}

function loop () {
    let goon = () => setTimeout(loop, config.pollInterval)
    tick().then(goon).catch(goon)
}

exports.startup = async function () {
    for (let job of (await Job.findAll({ where: { state: jobStates.PREPARING } }))) {
        await cleanJob(job, 'Job interrupted during preparation')
    }
    for (let job of (await Job.findAll({ where: { state: jobStates.CLEANING } }))) {
        await cleanJob(job, 'Job interrupted during cleaning')
    }
    for (let job of (await Job.findAll({ where: { state: jobStates.STOPPING } }))) {
        await cleanJob(job, 'Job interrupted during stopping')
    }

    clusterEvents.on('restricted', async () => {
        for(let job of (await Job.findAll({
            where: { '$between': [jobStates.PREPARING, jobStates.WAITING] }
        }))) {
            if (reservations.canAllocate(job.resourceRequest, job.user)) {
                await stopJob(job, 'Cluster cannot fulfill resource request anymore')
            }
        }
    })
    
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
    
    clusterEvents.on('pitReport', async pits => {
        pits = pits.reduce((hashMap, obj) => {
            hashMap[obj] = true
            return hashMap
        }, {})
        for (let job of (await Job.findAll({ where: { state: jobStates.RUNNING } }))) {
            if (!pits[job.id]) {
                await stopJob(job, 'Missing pit')
            }
        }
    })
    
    loop()
}
