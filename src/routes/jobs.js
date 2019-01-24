const fs = require('fs-extra')
const zlib = require('zlib')
const tar = require('tar-fs')
const ndir = require('node-dir')
const Parallel = require('async-parallel')
const Sequelize = require('sequelize')
const Router = require('express-promise-router')
const Pit = require('../models/Pit-model.js')
const Job = require('../models/Job-model.js')
const Group = require('../models/Group-model.js')
const scheduler = require('../scheduler.js')
const reservations = require('../reservations.js')
const parseClusterRequest = require('../clusterParser.js').parse

const fslib = require('../utils/httpfs.js')
const clusterEvents = require('../utils/clusterEvents.js')
const { getDuration } = require('../utils/dateTime.js')
const { ensureSignedIn } = require('./users.js')

const jobStates = Job.jobStates

var router = module.exports = new Router()

router.use(ensureSignedIn)

router.post('/', async (req, res) => {
    let job = req.body
    var clusterRequest
    try {
        clusterRequest = parseClusterRequest(job.clusterRequest)
    } catch (ex) {
        res.status(400).send({ message: 'Problem parsing allocation' })
        return
    }
    if (!(await reservations.canAllocate(clusterRequest, req.user))) {
        res.status(406).send({ message: 'Cluster cannot fulfill resource request' })
        return
    }
    if (job.continueJob) {
        let continueJob = await Job.findByPk(job.continueJob)
        if (!continueJob) {
            res.status(404).send({ message: 'The job to continue is not existing' })
            return
        }
        if (!(await req.user.canAccessJob(continueJob))) {
            res.status(403).send({ message: 'Continuing provided job not allowed for current user' })
            return
        }
    }
    let pit = await Pit.create()
    let provisioning
    if (job.origin) {
        provisioning = 'Git commit ' + job.hash + ' from ' + job.origin
        if (job.diff) {
            provisioning += ' with ' +
                (job.diff + '').split('\n').length + ' LoC diff'
        }
    } else if (job.archive) {
        provisioning = 'Archive (' + fs.statSync(job.archive).size + ' bytes)'
    }
    let dbjob = Job.create({
        id:           pit.id,
        userId:       req.user.id,
        description:  ('' + job.description).substring(0,20),
        provisioning: provisioning,
        request:      job.clusterRequest,
        continueJob:  job.continueJob
    })
    if (!job.private) {
        for(let autoshare of (await req.user.getAutoshares())) {
            await Job.JobGroup.create({ jobId: job.id, groupId: autoshare.groupId })
        }
    }
    var files = {}
    files['script'] = (job.script || 'if [ -f .compute ]; then bash .compute; fi') + '\n'
    if (job.origin) {
        files['origin'] = job.origin
    }
    if (job.hash) {
        files['hash'] = job.hash
    }
    if (job.diff) {
        files['git.patch'] = job.diff + '\n'
    }
    let jobDir = Pit.getDir(pit.id)
    await Parallel.each(Object.keys(files), filename => fs.writeFile(path.join(jobDir, filename), content))
    await job.setState(jobStates.NEW)
    res.status(200).send({ id: id })
})

router.get('/', async (req, res) => {
    res.send((await Job.findAll()).map(job => job.id))
})

function getJobDescription(job) {
    return {
        id:               job.id,
        description:      job.description,
        user:             job.userId,
        resources:        job.state >= jobStates.STARTING ? job.allocation : job.clusterRequest,
        state:            job.state,
        since:            getDuration(new Date(), job.since),
        schedulePosition: job.rank,
        utilComp:         job.state == jobStates.RUNNING ? job.curcompute : (job.aggcompute / (job.samples || 1)),
        utilMem:          job.state == jobStates.RUNNING ? job.curmemory  : (job.aggmemory  / (job.samples || 1))
    }
}

router.get('/status', async (req, res) => {
    let query = Job.infoQuery({
        where: { state: { [Sequelize.Op.gte]: jobStates.NEW, [Sequelize.Op.lte]: jobStates.STOPPING } }
    })
    let jobs = await Job.findAll(query)
    let running = jobs
        .filter(j => j.state >= jobStates.STARTING && j.state <= jobStates.STOPPING)
        .sort((a,b) => a.id - b.id)
    let waiting = jobs
        .filter(j => j.state == jobStates.WAITING)
        .sort((a,b) => a.rank - b.rank)
    waiting = waiting.concat(jobs.filter(j => j.state == jobStates.PREPARING))
    waiting = waiting.concat(jobs.filter(j => j.state == jobStates.NEW))
    let done = await Job.findAll(Job.infoQuery({
        where: { state: { [Sequelize.Op.gt]: jobStates.STOPPING } },
        order: [['id', 'ASC']], 
        limit: 20 
    }))
    res.send({
        running: running.map(job => getJobDescription(job)),
        waiting: waiting.map(job => getJobDescription(job)),
        done:    done   .map(job => getJobDescription(job))
    })
})

router.get('/:id', async (req, res) => {
    let job = await Job.findByPk(req.params.id)
    if (!job) {
        return Promise.reject({ code: 404, message: 'Job not found' })
    }
    let description = getJobDescription(job)
    description.allocation = job.allocation
    description.clusterRequest = job.clusterRequest
    description.continueJob = job.continueJob
    if(await req.user.canAccessJob(job)) {
        description.provisioning = job.provisioning
        description.groups = (await job.getJobgroups()).map(jg => jg.groupId).join(' ')
        description.states = (await job.getStates()).map(s => ({
            state:  s.state,
            since:  s.since,
            reason: s.reason
        }))
    }
    res.send(description)
})

async function targetJob (req, res) {
    req.targetJob = await Job.findByPk(req.params.id)
    return req.targetJob ? Promise.resolve('next') : Promise.reject({ code: 404, message: 'Job not found' })
}

async function canAccess (req, res) {
    return req.user.canAccessJob(req.targetJob) ? Promise.resolve('next') : Promise.reject({ code: 403, message: 'Not allowed' })
}

async function targetGroup (req, res) {
    req.targetGroup = await Group.findByPk(req.params.group)
    return req.targetGroup ? Promise.resolve('next') : Promise.reject({ code: 404, message: 'Group not found' })
}

router.put('/:id/groups/:group', targetJob, canAccess, targetGroup, async (req, res) => {
    await Job.JobGroup.insertOrUpdate({ jobId: req.targetJob.id, groupId: req.targetGroup.id })
    res.send()
})

router.delete('/:id/groups/:group', targetJob, canAccess, targetGroup, async (req, res) => {
    await Job.JobGroup.destroy({ where: { jobId: req.targetJob.id, groupId: req.targetGroup.id } })
    res.send()
    clusterEvents.emit('restricted')
})

router.get('/:id/targz', targetJob, canAccess, async (req, res) => {
    let jobDir = Pit.getDir(req.targetJob.id)
    res.status(200).type('tar.gz')
    tar.pack(jobDir).pipe(zlib.createGzip()).pipe(res)
})

async function targetPath (req, res) {
    let jobDir = Pit.getDir(req.targetJob.id)
    let newPath = path.resolve(jobDir, req.params[0] || '')
    if (newPath.startsWith(jobDir)) {
        req.targetPath = newPath
        return Promise.resolve('next')
    } else {
        return Promise.reject({ code: 404, message: "Path not found" })
    }
}

router.get('/:id/stats/(*)?', targetJob, canAccess, targetPath, async (req, res) => {
    fs.stat(req.targetPath, (err, stats) => {
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

router.get('/:id/content/(*)?', targetJob, canAccess, targetPath, async (req, res) => {
    fs.stat(req.targetPath, (err, stats) => {
        if (err || !(stats.isDirectory() || stats.isFile())) {
            res.status(404).send()
        } else {
            if (stats.isDirectory()) {
                ndir.files(req.targetPath, 'all', (err, paths) => {
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
                fs.createReadStream(req.targetPath).pipe(res)
            }
        }
    })
})

router.get('/:id/log', targetJob, canAccess, async (req, res) => {
    res.writeHead(200, {
        'Connection': 'keep-alive',
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-cache'
    })
    req.connection.setTimeout(60 * 60 * 1000)
    let interval = config.pollInterval / 10
    let logPath = path.join(Pit.getDir(req.targetJob.id), 'pit.log')
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
        if (req.targetJob.state <= jobStates.STOPPING) {
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
})

router.post('/:id/fs', targetJob, canAccess, async (req, res) => {
    let chunks = []
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => fslib.serve(
        fslib.readOnly(fslib.real(Pit.getDir(req.targetJob.id))), 
        Buffer.concat(chunks), 
        result => res.send(result), config.debugJobFS)
    )
})

router.post('/:id/stop', targetJob, canAccess, async (req, res) => {
    if (req.targetJob.state <= jobStates.RUNNING) {
        await scheduler.stopJob(req.targetJob)
        res.send()
    } else {
        res.status(412).send({ message: 'Only jobs before or in running state can be stopped' })
    }
})

router.delete('/:id', targetJob, canAccess, async (req, res) => {
    if (req.targetJob.state >= jobStates.DONE) {
        await req.targetJob.destroy()
    } else {
        res.status(412).send({ message: 'Only stopped jobs can be deleted' })
    }
})
