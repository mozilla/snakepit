const fs = require('fs-extra')
const https = require('https')
const axios = require('axios')
const cluster = require('cluster')
const assign = require('assign-deep')
const Parallel = require('async-parallel')
const { EventEmitter } = require('events')

const store = require('./store.js')
const config = require('./config.js')
const { getAlias } = require('./aliases.js')

const lxdStatus = {
    created:    100,
    started:    101,
    stopped:    102,
    running:    103,
    canceling:  104,
    pending:    105,
    starting:   106,
    stopping:   107,
    aborting:   108,
    freezing:   109,
    frozen:     110,
    thawed:     111,
    success:    200,
    failure:    400,
    cancelled:  401
}

const snakepitPrefix = 'sp'
const containerNameParser = /sp-([a-z][a-z0-9]*)-([0-9]+)-(d|0|[1-9][0-9]*)/
const pitCountExp = /PIT_WORKER_COUNT=([0-9]+)/

const nodeStates = {
    OFFLINE: 0,
    ONLINE:  1
}
exports.nodeStates = nodeStates

const headNode = { id: 'head', lxdEndpoint: config.lxdEndpoint }
exports.headNode = headNode

var testedNodes = {}

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
    let response = await promise
    let data = response.data
    if (typeof data === 'string' || data instanceof String) {
        return data
    } else {
        switch(data.type) {
            case 'sync':
                if (data.metadata) {
                    if (data.metadata.err) {
                        throw data.metadata.err
                    }
                    return data.metadata
                } else {
                    return data
                }
            case 'async':
                console.log('Forwarding:', data.operation + '/wait')
                return await wrapLxdResponse(node, axios.get(node.lxdEndpoint + data.operation + '/wait', { httpsAgent: agent }))
            case 'error':
                throw data.error
        }
    }
}

function callLxd(method, node, resource, data, options) {
    let axiosConfig = assign({
        method: method,
        url: getUrl(node, resource),
        httpsAgent: agent,
        data: data
    }, options || {})
    console.log(method, axiosConfig.url, data || '')
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
    return getContainerName(headNode.id, pitId, 'd')
}

function parseContainerName (containerName) {
    let match = containerNameParser.exec(containerName)
    return match && [match[1], match[2], match[3]]
}

function getNodeFromName (containerName) {
    let parsed = parseContainerName(containerName)
    let node = getNodeById(parsed[0])
    return node
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
    let results = await lxdGet(node, 'containers')
    return results.map(v => {
        v = v.split('/')
        return v.length > 0 ? v[v.length - 1] : null
    }).filter(v => v && parseContainerName(v))
}

function setContainerState (containerName, state, force, stateful) {
    let node = getNodeFromName(containerName)
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

async function pullFile (containerName, targetPath) {
    let node = getNodeFromName(containerName)
    return await lxdGet(node, 'containers/' + containerName + '/files?path=' + targetPath)
}

async function pitRequestedStop (pitId) {
    let containerName = getDaemonName(pitId)
    let [err, content] = await to(pullFile(containerName, '/data/pit/stop'))
    if (err) {
        console.log('ERROR getting stop file:', err.response.status)
        return false
    }
    return true
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

function newPitId () {
    return new Promise(
        (resolve, reject) => store.lockAsyncRelease('jobs', function(free) {
            let newId = db.pitIdCounter++
            free()
            resolve(newId)
        })
    )
}

function getPitDir (pitId) {
    return path.join(config.pitsDir, pitId + '')
}
exports.getPitDir = getPitDir

async function createPit () {
    let pitId = await newPitId()
    await fs.mkdirp(getPitDir(pitId))
    broadcast('pitCreated', pitId)
    return pitId
}
exports.createPit = createPit

async function deletePit (pitId) {
    await fs.remove(getPitDir(pitId))
    broadcast('pitDeleted', pitId)
}
exports.deletePit = deletePit

async function startPit (pitId, drives, workers) {
    try {
        broadcast('pitStarting', pitId)
        let pitDir = getPitDir(pitId)
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
                        tunnelConfig[tunnel + '.id'] = '' + pitId
                    }
                }
                await lxdPost(physicalNodes[localEndpoint], 'networks', {
                    name: network,
                    config: tunnelConfig
                })
            })
        }

        let daemonDevices = { 'pit': { path: '/data/pit', source: pitDir, type: 'disk' } }
        if (network) {
            daemonDevices['eth0'] = { nictype: 'bridged', parent: network, type: 'nic' }
        }
        if (drives) {
            for (let dest of Object.keys(drives)) {
                daemonDevices[dest] = {
                    path:   '/data/' + dest,
                    source: drives[dest],
                    type:   'disk'
                }
            }
        }
        let daemonContainerName = getDaemonName(pitId)
        let pitInfo = {
            JOB_NUMBER:         pitId,
            PIT_DAEMON_HOST:    daemonContainerName + '.lxd',
            PIT_WORKER_COUNT:   workers.length,
            PIT_WORKER_PREFIX:  snakepitPrefix + pitId + '-',
            PIT_WORKER_SUFFIX: '.lxd'
        }

        await addContainer(
            daemonContainerName, 
            daemonHash, 
            assign({ PIT_ROLE: 'daemon', PIT_WORKER_INDEX: 'd' }, pitInfo), 
            { devices: daemonDevices }
        )
        await Parallel.each(workers, async function createWorker(worker) {
            let index = workers.indexOf(worker)
            let containerName = getContainerName(worker.node.id, pitId, index)
            let workerDevices = {}
            if (network) {
                workerDevices['eth0'] = { nictype: 'bridged', parent: network, type: 'nic' }
            }
            await fs.mkdirp(path.join(pitDir, 'workers', index))
            await addContainer(
                containerName, 
                workerHash, 
                assign({ PIT_ROLE: worker.role || 'worker ' + index, PIT_WORKER_INDEX: index }, pitInfo), 
                { devices: workerDevices }, 
                worker.script
            )
        })

        await Parallel.each(workers, async function (worker) {
            let containerName = getContainerName(worker.node.id, pitId, workers.indexOf(worker))
            await setContainerState(containerName, 'start')
        })
        await setContainerState(daemonContainerName, 'start')
        broadcast('pitStarted', pitId)
    } catch (ex) {
        broadcast('pitStartFailed', pitId, ex)
        await stopPit(pitId)
        throw ex
    }
}
exports.startPit = startPit

function waitForPit (pitId, timeout) {
    return new Promise((resolve, reject) => {
        let timer
        let stopListener = (stoppingPitId, results) => {
            if (stoppingPitId == pitId) {
                if (timer) {
                    clearTimeout(timer)
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
            timer = setTimeout(timeoutListener, 1000 * timeout)
        }
    })
}
exports.waitForPit = waitForPit

async function runPit (pitId, drives, workers, timeout) {
    await startPit(pitId, drives, workers)
    return await waitForPit(pitId, timeout)
}
exports.runPit = runPit

async function extractResults (pitId) {
    let daemonName = getDaemonName(pitId)
    let [errLog, pitLog] = await to(pullFile(daemonName, '/data/pit/pit.log'))
    let [errInfo, pitInfo] = await to(pullFile(daemonName, '/etc/pit_info'))
    let workerResults
    if (pitInfo) {
        let workerCount = 1
        try {
            workerCount = pitCountExp.exec(content)
            workerCount = (workerCount && int(workerCount[1])) || 1
        } catch (e) {}
        workerResults = await Parallel.map(Array.from(Array(workerCount).keys()), async index => {
            let workerPath = '/data/pit/workers/' + index + '/'
            let [errStatus, status] = await to(pullFile(daemonName, workerPath + 'status'))
            let [errResult, result] = await to(pullFile(daemonName, workerPath + 'result'))
            return {
                status: status ? ((!isNaN(parseFloat(status)) && isFinite(status)) ? (status * 1) : 1) : 1,
                result: result || ''
            }
        })
    }
    return { log: pitLog || '', results: workerResults || []}
}

async function stopPit (pitId) {
    let results = await extractResults(pitId) 
    let nodes = getAllNodes()
    await Parallel.each(nodes, async node => {
        let [err, containers] = await to(getContainersOnNode(node))
        if (containers) {
            for (let containerName of containers) {
                let containerInfo = parseContainerName(containerName)
                if (containerInfo && containerInfo[1] === pitId) {
                    await to(setContainerState(containerName, 'stop', true))
                    await to(lxdDelete(node, 'containers/' + containerName))
                }
            }
        }
    })
    await Parallel.each(nodes, async node => {
        await to(lxdDelete(node, 'networks/' + snakepitPrefix + pitId))
    })
    broadcast('pitStopped', pitId, results)
}
exports.stopPit = stopPit

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

function getAllNodes () {
    let nodes = [headNode]
    for (let nodeId of Object.keys(db.nodes)) {
        nodes.push(db.nodes[nodeId])
    }
    for (let nodeId of Object.keys(testedNodes)) {
        nodes.push(testedNodes[nodeId])
    }
    return nodes
}
exports.getAllNodes = getAllNodes

function getNodeById (nodeId) {
    return nodeId == 'head' ? headNode : (testedNodes[nodeId] || db.nodes[nodeId])
}
exports.getNodeById = getNodeById

function scanNode(node, callback) {
    exports.tick()
    createPit().then(pitId => {
        testedNodes[node.id] = node
        runPit(pitId, {}, [{ 
            node:    node,
            devices: { 'gpu': { type: 'gpu' } },
            script:  'cat /proc/ >$RESULT_FILE'
        }]).then(results => {
            delete testedNodes[node.id]
            if (results.length > 0) {
                let raw = results[0]
                console.log(raw.result)
                callback(null, [{ type: 'cuda', index: 0 }])
            } else {
                callback('No worker responded')
            }
        }).catch(err => {
            delete testedNodes[node.id]
            callback(err)
        })
    }).catch(err => callback(err))
}
exports.scanNode = scanNode

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
                scanNode(newnode, (err, result) => {
                    if (err) {
                        res.status(400).send({ message: 'Node not available:\n' + err })
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

process.on('message', msg => {
    if (msg.pitEvent) {
        if (cluster.isMaster) {
            broadcast(msg.pitEvent, ...msg.args)
        } else {
            exports.emit(pitEvent, ...args)
        }
    }
})

function broadcast(pitEvent, ...args) {
    let message = {
        pitEvent: pitEvent,
        args: args
    }
    console.log('BROADCAST', pitEvent, ...args)
    if (cluster.isMaster) {
        exports.emit(pitEvent, ...args)
        for(let wid in cluster.workers) {
            cluster.workers[wid].send(message)
        }
    } else {
        process.send(message)
    }
}

async function tick () {
    Parallel.each(await getPits(), async pitId => {
        if (await pitRequestedStop(pitId)) {  
            console.log('DROPPING PIT:', pitId) 
            await stopPit(pitId)
        }
    })
}

exports.tick = function () {
    let goon = () => setTimeout(exports.tick, config.pollInterval)
    tick().then(goon).catch(goon)
}
