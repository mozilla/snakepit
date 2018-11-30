const path = require('path')
const fslib = require('httpfslib')
const nodes = require('./nodes.js')
const store = require('./store.js')
const config = require('./config.js')
const usersModule = require('./users.js')
const groupsModule = require('./groups.js')

var db = store.root

exports.initApp = function(app) {
    app.post('/jobfs/:id/:token', function(req, res) {
        var job = exports.loadJob(req.params.id)
        if (job) {
            let user = db.users[job.user]
            var token = req.params.token
            if (token && job.token && job.token.trim() == token.trim()) {
                let jfs = fslib.vDir({
                    'job':    () => fslib.real(nodes.getPitDir(job.id)),
                    'shared': () => fslib.readOnly(fslib.real(path.join(config.dataRoot, 'shared'))),
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