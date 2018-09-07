const fs = require('fs')
const path = require('path')
const rimraf = require('rimraf')
const fslib = require('httpfslib')
const store = require('./store.js')
const config = require('./config.js')


var db = store.root

var exports = module.exports = {}
const dataRoot = exports.dataRoot = config.dataRoot || '/snakepit'
const sharedDir = exports.sharedDir = path.join(dataRoot, 'shared')
const groupsDir = exports.groupsDir = path.join(dataRoot, 'groups')
const uploadsDir = exports.uploadDir = path.join(dataRoot, 'uploads')

exports.getJobsDir = function() {
    return path.join(dataRoot, 'jobs')
}

exports.getJobDirById = function(jobId) {
    return path.join(exports.getJobsDir(), jobId + '')
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
    if (!fs.existsSync(jobPath)) {
        fs.mkdirSync(jobPath)
    }
    fs.writeFileSync(path.join(jobPath, 'meta.json'), JSON.stringify(job))
}

exports.deleteJobDir = function(jobId, callback) {
    let jobDir = exports.getJobDirById(jobId)
    rimraf(jobDir, callback)
}

exports.initApp = function(app) {
    app.post('/jobs/:id/fs/:token', function(req, res) {
        var job = exports.loadJob(req.params.id)
        let user = db.users[job.user]
        var token = req.params.token
        if (token && job && job.token === token) {
            let jfs = fslib.vDir({
                'job':    () => fslib.real(getJobDir(job)),
                'shared': () => fslib.readOnly(fslib.real(sharedDir)),
                'groups': () => fslib.readOnly(fslib.vDir(
                    () => (user && Array.isArray(user.groups)) ? user.groups : [],
                    group => user && Array.isArray(user.groups) && user.groups.includes(group) ? fslib.readOnly(fslib.real(path.join(groupsDir, group))) : null
                ))
            })
            let chunks = []
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => fslib.serve(jfs, Buffer.concat(chunks), result => {
                res.write(result)
                res.end()
            }))
        } else {
            res.status(401).json({ message: 'Wrong token or job' })
        }
    })
}