const fs = require('fs')
const path = require('path')
const { exec, execFile, spawn } = require('child_process')
const store = require('./store.js')

var exports = module.exports = {}

var db = store.root

const STATE_UNKNOWN = exports.STATE_UNKNOWN = 0
const STATE_OFFLINE = exports.STATE_OFFLINE = 1
const STATE_ACTIVE = exports.STATE_ACTIVE = 2

function _runScript(node, scriptName, callback) {
    let scriptPath = path.join(__dirname, '..', 'scripts', scriptName)
    let address = node.user + '@' + node.address
    console.log('Running script "' + scriptPath + '" on "' + address + '"')
    p = execFile(
        'ssh', 
        [address, '-p', node.port, 'bash -s'], 
        null, 
        callback
    )
    fs.createReadStream(scriptPath).pipe(p.stdin)
}

function _checkAvailability(node, callback) {
    _runScript(node, 'available.sh', (err, stdout, stderr) => {
        console.log(stdout)
        if (err) {
            console.error(stderr)
            callback(false)
        } else {
            callback(true)
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
                gpus: node.hasOwnProperty('gpus') ? node.gpus : dbnode.gpus,
                user: node.user || dbnode.user || 'pitmaster',
                state: STATE_UNKNOWN
            }
            if (newnode.address) {
                _checkAvailability(newnode, available => {
                    if (available) {
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