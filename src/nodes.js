const fs = require('fs')
const stream = require('stream')
const path = require('path')
const CombinedStream = require('combined-stream')
const { spawn } = require('child_process')
const store = require('./store.js')

var exports = module.exports = {}

var db = store.root

const STATE_UNKNOWN = exports.STATE_UNKNOWN = 0
const STATE_OFFLINE = exports.STATE_OFFLINE = 1
const STATE_ONLINE = exports.STATE_ONLINE = 2

function _runScript(node, scriptName, env, callback) {
    if (typeof env == 'function') {
        callback = env
        env = {}
    }
    let scriptPath = path.join(__dirname, '..', 'scripts', scriptName)
    fs.readFile(scriptPath, function read(err, content) {
        if (!err) {
            env = env || {}
            let address = node.user + '@' + node.address
            console.log('Running script "' + scriptPath + '" on "' + address + '"')
            p = spawn('ssh', [address, '-p', node.port, 'bash -s'])
            let stdout = []
            p.stdout.on('data', data => stdout.push(data))
            let stderr = []
            p.stderr.on('data', data => stderr.push(data))
            p.on('close', code => callback(code, stdout.join('\n'), stderr.join('\n')))
            var stdinStream = new stream.Readable()
            Object.keys(env).forEach(name => stdinStream.push('export ' + name + '=' + env[name] + '\n'))
            stdinStream.push(content + '\n')
            stdinStream.push(null)
            stdinStream.pipe(p.stdin)
        }
    })
}

function _checkAvailability(node, callback) {
    _runScript(node, 'available.sh', (err, stdout, stderr) => {
        console.log(stdout)
        if (err) {
            console.error(err)
            callback()
        } else {
            var resources = {}
            stdout.split('\n').forEach(line => {
                let [type, model] = line.split(':')
                if (type && model) {
                    resources[type] = resources[type] || []
                    resources[type].push({ model: model, index: resources[type].length })
                }
            })
            callback(resources)
        }
    })
}

exports.initDb = function() {
    if (!db.nodes) {
        db.nodes = {}
    }
}

exports.initApp = function(app) {
    app.put('/nodes/:id', function(req, res) {
        if (req.user.admin) {
            var id = req.params.id
            node = req.body
            dbnode = db.nodes[id] || {}
            newnode = {
                id: id,
                address: node.address || dbnode.address,
                port: node.port || dbnode.port || 22,
                user: node.user || dbnode.user || 'pitmaster',
                state: STATE_ONLINE
            }
            if (newnode.address) {
                _checkAvailability(newnode, resources => {
                    if (resources) {
                        if (node.cvd) {
                            console.log(node.cvd)
                            Object.keys(resources).forEach(type => {
                                resources[type] = resources[type]
                                    .filter(resource => type != 'cuda' || node.cvd.includes(resource.index))
                            })
                        }
                        newnode.resources = resources
                        db.nodes[id] = newnode
                        res.status(200).send()
                    } else {
                        res.status(400).send({ message: 'Node not available' })
                    }
                })
            } else {
                res.status(400).send()
            }
        } else {
            res.status(403).send()
        }
    })

    app.get('/nodes', function(req, res) {
        res.status(200).send(Object.keys(db.nodes))
    })

    app.get('/nodes/:id', function(req, res) {
        var node = db.nodes[req.params.id]
        if (node) {
            res.status(200).json(node)
        } else {
            res.status(404).send()
        }
    })

    app.delete('/nodes/:id', function(req, res) {
        if (req.user.admin) {
            var id = req.params.id
            if (db.nodes[id]) {
                delete db.nodes[id]
                res.status(200).send()
            } else {
                res.status(404).send()
            }
        } else {
            res.status(403).send()
        }
    })
}