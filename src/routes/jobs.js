const fs = require('fs-extra')
const path = require('path')
const zlib = require('zlib')
const tar = require('tar-fs')
const Tail = require('tail').Tail
const ndir = require('node-dir')
const Parallel = require('async-parallel')
const Sequelize = require('sequelize')
const Router = require('express-promise-router')
const Pit = require('../models/Pit-model.js')
const Job = require('../models/Job-model.js')
const config = require('../config.js')
const scheduler = require('../scheduler.js')
const reservations = require('../reservations.js')
const parseClusterRequest = require('../clusterParser.js').parse

const log = require('../utils/logger.js')
const fslib = require('../utils/httpfs.js')
const clusterEvents = require('../utils/clusterEvents.js')
const { getDuration } = require('../utils/dateTime.js')
const { ensureSignedIn, targetJob, targetGroup } = require('./mw.js')

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

    let pit
    let dbjob
    try {
        pit = await Pit.create()
        let provisioning
        if (job.origin) {
            provisioning = 'Git commit ' + job.hash + ' from ' + job.origin
            if (job.diff) {
                provisioning += ' with ' +
                    (job.diff + '').split('\n').length + ' LoC diff'
            }
        } else if (job.archive) {
            provisioning = 'Archive (' + fs.statSync(job.archive).size + ' bytes)'
        } else {
            provisioning = 'Script'
        }
        let dbjob = await Job.create({
            id:           pit.id,
            userId:       req.user.id,
            description:  ('' + job.description).substring(0,20),
            provisioning: provisioning,
            request:      job.clusterRequest,
            continues:    job.continueJob
        })
        if (!job.private) {
            for(let autoshare of (await req.user.getAutoshares())) {
                await Job.JobGroup.create({ jobId: dbjob.id, groupId: autoshare.groupId })
            }
        }
        var files = {}
        files['script.sh'] = (job.script || 'if [ -f .compute ]; then bash .compute; fi') + '\n'
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
        await Parallel.each(Object.keys(files), filename => fs.writeFile(path.join(jobDir, filename), files[filename]))
        await dbjob.setState(jobStates.NEW)
        res.status(200).send({ id: pit.id })
    } catch (ex) {
        if (dbjob) {
            await dbjob.destroy()
        }
        if (pit) {
            await pit.destroy()
        }
        res.status(500).send({ message: ex.toString() })
    }
})

function getJobDescription(job) {
    return {
        id:               job.id,
        description:      job.description,
        user:             job.userId,
        resources:        job.allocation || job.request,
        state:            job.state,
        date:             job.since,
        since:            getDuration(new Date(), job.since),
        schedulePosition: job.rank,
        utilComp:         job.state == jobStates.RUNNING ? job.dataValues.curcompute :
                            (job.dataValues.aggcompute / (job.dataValues.samples || 1)),
        utilMem:          job.state == jobStates.RUNNING ? job.dataValues.curmemory  :
                            (job.dataValues.aggmemory  / (job.dataValues.samples || 1))
    }
}

router.get('/', async (req, res) => {
    const orderings = {
        'date':  'since', 
        'user':  'user', 
        'title': 'description', 
        'state': 'state'
    }
    let query = { where: {}, order: [], limit: config.queryLimit }
    const parseDate = v => { try { return new Date(v) } catch (ex) { return null } }
    let parsers = {
        since:  v => parseDate(v) ? (query.where.since = { [Sequelize.Op.gte]: parseDate(v) }) : false,
        till:   v => parseDate(v) ? (query.where.since = { [Sequelize.Op.lte]: parseDate(v) }) : false,
        user:   v => query.where.userId = v,
        title:  v => query.where.description = { [Sequelize.Op.like]: v },
        asc:    v => orderings[v] ? query.order.push([orderings[v], 'ASC']) : false,
        desc:   v => orderings[v] ? query.order.push([orderings[v], 'DESC']) : false,
        limit:  v => !isNaN(parseInt(v)) && (query.limit = Math.min(v, query.limit)),
        offset: v => !isNaN(parseInt(v)) && (query.offset = v)
    }
    for(let param of Object.keys(req.query)) {
        let parser = parsers[param]
        if (parser) {
            if (!parser(req.query[param])) {
                res.status(400).send({ message: 'Cannot parse query parameter ' + param })
                return
            }
        } else {
            res.status(400).send({ message: 'Unknown query parameter ' + param })
            return
        }
    }
    query.order.push(['since', 'DESC'])
    let jobs = await Job.findAll(Job.infoQuery(query))
    res.send(jobs.map(job => getJobDescription(job)))
})

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
        order: [['since', 'DESC']], 
        limit: 20 
    }))
    res.send({
        running: running.map(job => getJobDescription(job)),
        waiting: waiting.map(job => getJobDescription(job)),
        done:    done   .map(job => getJobDescription(job))
    })
})

router.get('/:job', async (req, res) => {
    let query = Job.infoQuery({ where: { id: req.params.job } })
    let job = await Job.findOne(query)
    if (!job) {
        return Promise.reject({ code: 404, message: 'Job not found' })
    }
    let description = getJobDescription(job)
    description.allocation = job.allocation
    description.clusterRequest = job.clusterRequest
    if (job.continues) {
        description.continueJob = job.continues
    }
    if(await req.user.canAccessJob(job)) {
        let groups = (await job.getJobgroups()).map(jg => jg.groupId)
        description.provisioning = job.provisioning
        description.groups = groups.length > 0 && groups
        description.stateChanges = (await job.getStates({ order: ['since'] })).map(s => ({
            state:  s.state,
            since:  s.since,
            reason: s.reason
        }))
        let processes = []
        for(let processGroup of await job.getProcessgroups()) {
            for(let jobProcess of await processGroup.getProcesses()) {
                processes.push({ 
                    groupIndex:     processGroup.index,
                    processIndex:   jobProcess.index,
                    status:         (jobProcess.status === 0 || jobProcess.status > 0) ? jobProcess.status : '?',
                    result:         jobProcess.result 
                })
            }
        }
        if (processes.length > 0) {
            description.processes = processes
        }
    }
    res.send(description)
})

async function canAccess (req, res) {
    return (await req.user.canAccessJob(req.targetJob)) ? Promise.resolve('next') : Promise.reject({ code: 403, message: 'Forbidden' })
}

router.put('/:job/groups/:group', targetJob, canAccess, targetGroup, async (req, res) => {
    await Job.JobGroup.insertOrUpdate({ jobId: req.targetJob.id, groupId: req.targetGroup.id })
    res.send()
})

router.delete('/:job/groups/:group', targetJob, canAccess, targetGroup, async (req, res) => {
    await Job.JobGroup.destroy({ where: { jobId: req.targetJob.id, groupId: req.targetGroup.id } })
    res.send()
    clusterEvents.emit('restricted')
})

router.get('/:job/targz', targetJob, canAccess, async (req, res) => {
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

router.get('/:job/stats/(*)?', targetJob, canAccess, targetPath, async (req, res) => {
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

router.get('/:job/content/(*)?', targetJob, canAccess, targetPath, async (req, res) => {
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

router.get('/:job/log', targetJob, canAccess, async (req, res) => {
    res.writeHead(200, {
        'Connection':    'keep-alive',
        'Content-Type':  'text/plain',
        'Cache-Control': 'no-cache'
    })
    req.connection.setTimeout(60 * 60 * 1000)
    let interval = config.pollInterval
    let logPath = path.join(Pit.getDir(req.targetJob.id), 'pit.log')

    if (req.targetJob.state <= jobStates.STOPPING) {
        let tail
        let startTail = () => {
            tail = new Tail(logPath, { fromBeginning: true })
            tail.on("line", line => !res.finished && res.write(line + '\n'))
            tail.on("error", stopTail)
            res.on('close', stopTail)
            res.on('end', stopTail)
        }
        let stopTail = () => {
            if (tail) {
                tail.unwatch()
                tail = null
            }
            res.end()
        }
        let poll = () => {
            if (tail) {
                req.targetJob.reload().then(() => {
                    if (req.targetJob.state > jobStates.STOPPING) {
                        stopTail()
                    } else {
                        setTimeout(poll, interval)
                    }
                }).catch(stopTail)
            } else {
                if (fs.existsSync(logPath)) {
                    startTail()
                }
                setTimeout(poll, interval)
            }
        }
        poll()
    } else if (fs.existsSync(logPath)) {
        let stream = fs.createReadStream(logPath)
        stream.on('data', chunk => res.write(chunk))
        stream.on('end',  res.end.bind(res))
    } else {
        res.status(404).send()
    }
})

router.post('/:job/fs', targetJob, canAccess, async (req, res) => {
    let chunks = []
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => fslib.serve(
        fslib.readOnly(fslib.real(Pit.getDir(req.targetJob.id))), 
        Buffer.concat(chunks), 
        result => res.send(result), config.debugJobFS)
    )
})

router.post('/:job/stop', targetJob, canAccess, async (req, res) => {
    if (req.targetJob.state <= jobStates.STOPPING) {
        await scheduler.stopJob(req.targetJob, 'Stopped by user ' + req.user.id)
        res.send()
    } else {
        res.status(412).send({ message: 'Only jobs before or in running state can be stopped' })
    }
})

router.delete('/:job', targetJob, canAccess, async (req, res) => {
    if (req.targetJob.state >= jobStates.DONE) {
        await req.targetJob.destroy()
        res.send()
    } else {
        res.status(412).send({ message: 'Only stopped jobs can be deleted' })
    }
})
