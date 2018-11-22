const https = require('https')
const axios = require('axios')
const cluster = require('cluster')
const assign = require('assign-deep')
const Parallel = require('async-parallel')
const { EventEmitter } = require('events')

const pits = require('./pits.js')
const store = require('./store.js')
const config = require('./config.js')
const { getAlias } = require('./aliases.js')

const lxdStatus = {
    opCreated:  100,
    started:    101,
    stopped:    102,
    running:    103,
    canceling:  104,
    pending:    105,
    starting:   106,
    stoping:    107,
    aborting:   108,
    freezing:   109,
    frozen:     110,
    thawed:     111,
    success:    200,
    failure:    400,
    cancelled:  401
}

const snakepitPrefix = 'sp'
const containerNameParser = /sp-([a-z][a-z0-9]*)-([0-9]+)-(d|0|[1-9][0-9]*)/g;
const nodeStates = {
    OFFLINE: 0,
    ONLINE:  1
}
exports.nodeStates = nodeStates

const headNode = { id: 'head', lxdEndpoint: config.lxdEndpoint }
exports.headNode = headNode

var agent = new https.Agent({ 
    key: config.lxdKey, 
    cert: config.lxdCert,
    rejectUnauthorized: false
})

var headInfo
var exports = module.exports = {}
var db = store.root
var observers = {}
var toRemove = {}

var exports = module.exports = new EventEmitter()

function to (promise) {
    return promise.then(data => [null, data]).catch(err => [err])
}

function sleep (ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function wrapLxdResponse (node, promise) {
    let [err, response] = await to(promise)
    if (err) {
        console.log(err)
        throw err.message
    }
    let data = response.data
    switch(data.type) {
        case 'sync':
            if (data.metadata && data.metadata.err) {
                throw data.metadata.err
            }
            return data.metadata
        case 'async':
            console.log('Forwarding:', data.operation + '/wait')
            return await wrapLxdResponse(node, axios.get(node.lxdEndpoint + data.operation + '/wait', { httpsAgent: agent }))
        case 'error':
            throw data.error
    }
}

function callLxd(method, node, resource, data, options) {
    let axiosConfig = assign({
        method: method,
        url: getUrl(node, resource),
        httpsAgent: agent,
        data: data
    }, options || {})
    //console.log(method, axiosConfig, data)
    return wrapLxdResponse(node, axios(axiosConfig))
}

function lxdGet (node, resource, options) {
    return callLxd('get', node, resource, undefined, options)
}

function lxdDelete (node, resource, options) {
    return callLxd('delete', node, resource, undefined, options)
}

function lxdPut (node, resource, data, options) {
    return callLxd('put', node, resource, data, options)
}

function lxdPost (node, resource, data, options) {
    return callLxd('post', node, resource, data, options)
}

function getContainerName (nodeId, pitId, instance) {
    return snakepitPrefix + '-' + nodeId + '-' + pitId + '-' + instance
}

function getDaemonName (pitId) {
    return getContainerName(headNode, pitId, 'd')
}

function parseContainerName (containerName) {
    let match = containerNameParser.exec(containerName)
    return match && [match[1], match[2], match[3]]
}

function getNodeFromName (containerName) {
    return getNodeById(parseContainerName(containerName)[1])
}

async function getHeadInfo () {
    if (headInfo) {
        return headInfo
    }
    return headInfo = await lxdGet(headNode, '')
}
exports.getHeadInfo = getHeadInfo

async function getHeadCertificate () {
    let info = await getHeadInfo()
    return info.environment && info.environment.certificate
}

function getUrl (node, resource) {
    return node.lxdEndpoint + '/1.0' + (resource ? ('/' + resource) : '')
}

async function getContainersOnNode (node) {
    let results = await to(lxdGet(node, 'containers'))
    return results.filter(result => parseContainerName(result))
}

function setContainerState (containerName, state, force, stateful) {
    return lxdPut(node, 'containers/' + containerName + '/state', {
        action:   state,
        timeout:  config.lxdTimeout,
        force:    !!force,
        stateful: !!stateful
    })
}

function getContainerState (containerName) {
    return lxdGet(getNodeFromName(containerName), 'containers/' + containerName + '/state')
}

async function getPitState (pitId) {
    return (await getContainerState(getDaemonName(pitId))).status_code
}

async function pitIsRunning (pitId) {
    return (await getPitState(pitId)) == lxdStatus.running
}

async function pushFile (containerName, targetPath, content) {
    let node = getNodeFromName(containerName)
    await lxdPost(
        node, 
        'containers/' + containerName + '/files?path=' + targetPath, 
        content, 
        {
            headers: { 
                'Content-Type': 'application/octet-stream',
                'X-LXD-type':   'file', 
                'X-LXD-write':  'overwrite'
            } 
        }
    )
}

async function addContainer (containerName, imageHash, pitInfo, options, script) {
    let node = getNodeFromName(containerName)
    let cert = await getHeadCertificate()
    let containerConfig = assign({
        name: containerName,
        architecture: 'x86_64',
        profiles: [],
        ephemeral: false,
        devices: {
            'root': {
				path: '/',
				pool: 'default',
				type: 'disk'
			}
        },
        source: {
            type:        'image',
            mode:        'pull',
            server:      config.lxdEndpoint,
            protocol:    'lxd',
            certificate: cert,
            fingerprint: imageHash
        },
    }, options || {})
    await lxdPost(node, 'containers', containerConfig)
    if (pitInfo) {
        let vars = []
        for (let name of Object.keys(pitInfo)) {
            vars.push(name + '=' + pitInfo[name] + '\n')
        }
        await pushFile(containerName, '/etc/pit_info', vars.join(''))
    }
    if (script) {
        await pushFile(containerName, '/usr/bin/script.sh', script)
    }
}

async function createPit (pitId, drives, workers) {
    try {
        let daemonHash = (await lxdGet(headNode, 'images/aliases/snakepit-daemon')).target
        let workerHash = (await lxdGet(headNode, 'images/aliases/snakepit-worker')).target

        let physicalNodes = { [headNode.lxdEndpoint]: headNode }
        for (let worker of workers) {
            // we just need one virtual node representant of/on each physical node
            physicalNodes[worker.node.lxdEndpoint] = worker.node
        }
        let network
        let endpoints = Object.keys(physicalNodes)
        if (endpoints.length > 1) {
            network = snakepitPrefix + pitId
            await Parallel.each(endpoints, async function (localEndpoint) {
                let tunnelConfig = {}
                for (let remoteEndpoint of endpoints) {
                    if (localEndpoint !== remoteEndpoint) {
                        let tunnel = 'tunnel.' + physicalNodes[remoteEndpoint].id
                        tunnelConfig[tunnel + '.protocol'] = 'vxlan',
                        tunnelConfig[tunnel + '.id'] = pitId
                    }
                }
                await lxdPost(physicalNodes[localEndpoint], 'networks', {
                    name: network,
                    config: tunnelConfig
                })
            })
        }

        let daemonDevices = {}
        if (network) {
            daemonDevices['eth0'] = { nictype: 'bridged', parent: network, type: 'nic' }
        }
        if (drives) {
            for (let dest of Object.keys(drives)) {
                daemonDevices[dest] = {
                    path: '/' + dest,
                    source: drives[dest],
                    type: 'disk'
                }
            }
        }
        let daemonContainerName = getDaemonName(pitId)
        let pitInfo = {
            JOB_NUMBER:         pitId,
            PIT_DAEMON_HOST:    daemonContainerName + '.lxd',
            PIT_WORKER_NUMBER:  workers.length,
            PIT_WORKER_PREFIX:  snakepitPrefix + pitId + '-',
            PIT_WORKER_POSTFIX: '.lxd'
        }

        await addContainer(daemonContainerName, daemonHash, pitInfo, { devices: daemonDevices })

        await Parallel.each(workers, async function (worker) {
            let containerName = getContainerName(worer.node.id, pitId, workers.indexOf(worker))
            let workerDevices = {}
            if (network) {
                workerDevices['eth0'] = { nictype: 'bridged', parent: network, type: 'nic' }
            }
            await addContainer(containerName, workerHash, pitInfo, { devices: workerDevices }, worker.script)
        })

        await setContainerState(daemonContainerName, 'start')
        await Parallel.each(workers, async function (worker) {
            let containerName = getContainerName(worer.node.id, pitId, workers.indexOf(worker))
            await setContainerState(containerName, 'start')
        })
    } catch (ex) {
        await dropPit(pitId)
        throw ex
    }
}
exports.createPit = createPit

function waitForPit (pitId, timeout) {
    return new Promise((resolve, reject) => {
        let timeouter
        let stopListener = (stoppingPitId, results) => {
            if (stoppingPitId == pitId) {
                if (timeouter) {
                    clearTimeout(timeouter)
                }
                exports.removeListener('pitStopped', stopListener)
                resolve(results)
            }
        }
        let timeoutListener = () => {
            exports.removeListener('pitStopped', stopListener)
            reject('timeout')
        }
        exports.on('pitStopped', stopListener)
        if (timeout) {
            timeouter = setTimeout(timeoutListener, 1000 * timeout)
        }
    })
}
exports.waitForPit = waitForPit

async function runPit (pitId, drives, workers, timeout) {
    await createPit(pitId, drives, workers)
    return await waitForPit(pitId, timeout)
}
exports.runPit = runPit

async function dropPit (pitId) {
    let nodes = {}
    await Parallel.each(getAllNodes(), async node => {
        let [err, containers] = await to(getContainersOnNode(node))
        if (containers) {
            for (let containerName of containers) {
                let containerInfo = parseContainerName(containerName)
                if (containerInfo && containerInfo[1] === pitId) {
                    nodes[node.lxdEndpoint] = node
                    await to(lxdDelete(node, 'containers/' + containerName))
                }
            }
        }
    })
    if (nodes.length > 1) {
        Parallel.each(Object.keys(nodes), async function (endpoint) {
            await to(lxdDelete(nodes[endpoint], 'networks/' + snakepitPrefix + pitId))
        })
    }
}
exports.dropPit = dropPit 

async function getPits () {
    let [err, containers] = await to(getContainersOnNode(headNode))
    let pitIds = {}
    for (let containerName of containers) {
        let containerInfo = parseContainerName(containerName)
        if (containerInfo) {
            pitIds[containerInfo[1]] = true
        }
    }
    return Object.keys(pitIds)
}
exports.getPits = getPits

exports.getAllNodes = function getAllNodes () {
    nodes = [headNode]
    for (let nodeId of Object.keys(db.nodes)) {
        nodes.push(db.nodes[nodeId])
    }
    return nodes
}

exports.getNodeById = function getNodeById (nodeId) {
    return nodeId == 'head' ? headNode : db.nodes[nodeId]
}

function scanNode(node) {
    return pits.runPit(id, {}, [{ 
        node: node, 
        devices: { 'gpu': { type: 'gpu' } },
        script: 'cat /proc/driver/nvidia/gpus/*/information'
    }])
}

function setNodeState(node, nodeState) {
    node.state = nodeState
    node.since = new Date().toISOString()
    exports.emit('state', node.id, node.state)
    if (toRemove[node.id] && node.state == nodeStates.OFFLINE) {
        setTimeout(() => {
            delete toRemove[node.id]
            delete db.nodes[node.id]
        }, 1000)
    }
}

exports.initDb = function() {
    if (!db.nodes) {
        db.nodes = {}
    }
    for (let node of Object.keys(db.nodes).map(k => db.nodes[k])) {
        node.state = nodeStates.OFFLINE
        if (node.since) {
            delete node.since
        }
    }
}

exports.initApp = function(app) {
    app.put('/nodes/:id', function(req, res) {
        if (req.user.admin) {
            let id = req.params.id
            let node = req.body
            let dbnode = db.nodes[id] || {}
            let newnode = {
                id: id,
                lxdEndpoint: node.lxdEndpoint || dbnode.lxdEndpoint,
                address: node.address || dbnode.address,
                state: nodeStates.ONLINE
            }
            if (newnode.lxdEndpoint) {
                scanNode(newnode, (code, result) => {
                    if (code > 0) {
                        res.status(400).send({ message: 'Node not available:\n' + result })
                    } else {
                        newnode.resources = {}
                        for(let resource of result) {
                            if (!node.cvd || resource.type != 'cuda' || node.cvd.includes(resource.index)) {
                                newnode.resources[resource.type + resource.index] = resource
                            }
                        }
                        db.nodes[id] = newnode
                        res.status(200).send()
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
            res.status(200).json({
                id:          node.id,
                lxdEndpoint: node.lxdEndpoint,
                address:     node.address,
                state:       node.state,
                since:       node.since,
                resources: Object.keys(node.resources).map(resourceId => {
                    let dbResource = node.resources[resourceId]
                    let resource = {
                        type:  dbResource.type,
                        name:  dbResource.name,
                        index: dbResource.index
                    }
                    let alias = getAlias(dbResource.name)
                    if (alias) {
                        resource.alias = alias
                    }
                    if (dbResource.groups) {
                        resource.groups = dbResource.groups
                    }
                    return resource
                })
            })
        } else {
            res.status(404).send()
        }
    })

    app.delete('/nodes/:id', function(req, res) {
        if (req.user.admin) {
            let node = db.nodes[req.params.id]
            if (node) {
                toRemove[node.id] = true
                let p = observers[node.id]
                if (p) {
                    p.kill()
                } else {
                    setNodeState(node, nodeStates.OFFLINE)
                }
                res.status(200).send()
            } else {
                res.status(404).send()
            }
        } else {
            res.status(403).send()
        }
    })
}

function broadcast(msg) {
    if (cluster.isMaster) {
        for(var wid in cluster.workers) {
            var worker = cluster.workers[wid]
            worker.send(msg)
        }
    } else {
        process.send(msg)
    }
}

process.on('message', msg => {
    if (msg.pitEvent) {
        exports.emit(msg.pitEvent, msg.pitId)
    }
})

async function tick () {
    let pits = await getPits()
    for (let pitId of pits) {
        if (await pitIsRunning(pitId)) {

        }
    }
}

exports.tick = function () {
    let goon = () => setTimeout(exports.tick, config.pollInterval)
    tick().then(goon).catch(goon)
}
