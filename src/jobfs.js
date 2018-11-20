const fs = require('fs')
const path = require('path')
const rimraf = require('rimraf')
const fslib = require('httpfslib')
const store = require('./store.js')
const config = require('./config.js')
const usersModule = require('./users.js')
const groupsModule = require('./groups.js')

var db = store.root

exports.getJobDirById = function(jobId) {
    return path.join(config.jobsDir, jobId + '')
}

exports.getJobDir = function(job) {
    return exports.getJobDirById(job.id)
}

exports.loadJob = function(jobId) {
    let job = db.jobs[jobId]
    if (job) {
        return job
    }
    let jobPath = path.join(exports.getJobDirById(jobId), 'meta.json')
    if (fs.existsSync(jobPath)) {
        return JSON.parse(fs.readFileSync(jobPath, 'utf8'))
    }
}

exports.saveJob = function(job) {
    let jobPath = exports.getJobDir(job)
    fs.writeFileSync(path.join(jobPath, 'meta.json'), JSON.stringify(job))
}

exports.newJobDir = function (callback) {
    store.lockAsyncRelease('jobs', function(free) {
        let newId = db.jobIdCounter++
        free()
        if (!fs.existsSync(jobPath)) {
            fs.mkdirSync(jobPath)
        }
        callback(newId)
    })
}

exports.deleteJobDir = function(jobId, callback) {
    let jobDir = exports.getJobDirById(jobId)
    rimraf(jobDir, callback)
}

exports.initApp = function(app) {
    app.post('/jobfs/:id/:token', function(req, res) {
        var job = exports.loadJob(req.params.id)
        if (job) {
            let user = db.users[job.user]
            var token = req.params.token
            if (token && job.token && job.token.trim() == token.trim()) {
                let jfs = fslib.vDir({
                    'job':    () => fslib.real(exports.getJobDir(job)),
                    'shared': () => fslib.readOnly(fslib.real(config.sharedDir)),
                    'groups': () => fslib.vDir(
                        () => groupsModule.getGroups(user),
                        group => groupsModule.isInGroup(user, group) ? fslib.real(groupsModule.getGroupDir(group)) : null
                    ),
                    'home':   () => fslib.real(usersModule.getHomeDir(user))
                })
                let chunks = []
                req.on('data', chunk => chunks.push(chunk));
                req.on('end', () => fslib.serve(jfs, Buffer.concat(chunks), result => res.send(result), config.debugJobFS))
            } else {
                res.status(408).send('Wrong token')
            }
        } else {
            res.status(404).send('Wrong job')
        }
    })
}