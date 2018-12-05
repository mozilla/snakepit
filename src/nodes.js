const fs = require('fs-extra')
const path = require('path')
const https = require('https')
const axios = require('axios')
const cluster = require('cluster')
const assign = require('assign-deep')
const Parallel = require('async-parallel')
const { EventEmitter } = require('events')

const log = require('./logger.js')
const store = require('./store.js')
const utils = require('./utils.js')
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
const resourceParser = /resource:([^,]*),([^,]*),([^,]*)/

var emitter = new EventEmitter()
var exports = module.exports = emitter
var headInfo
var db = store.root
var agent = new https.Agent({ 
    key: config.lxdKey, 
    cert: config.lxdCert,
    rejectUnauthorized: false
})
log.debug(config.lxdCert)

const nodeStates = {
    OFFLINE: 0,
    ONLINE:  1
}
exports.nodeStates = nodeStates

const headNode = { id: 'head', endpoint: config.endpoint }
exports.headNode = headNode

function broadcast(message, ignore) {
    for(let wid in cluster.workers) {
        let worker = cluster.workers[wid]
        if (worker !== ignore) {
            worker.send(message)
        }
    }
}

function emit(pitEvent, ...args) {
    emitter.emit(pitEvent, ...args)
    let message = {
        pitEvent: pitEvent,
        args: args
    }
    if (cluster.isMaster) {
        log.debug(pitEvent, ...args)
        broadcast(message)
    } else {
        process.send(message)
    }
}

if (cluster.isMaster) {
    cluster.on('fork', worker => {
        worker.on('message', message => {
            if (message.pitEvent) {
                broadcast(message, worker)
            }
        })
    })
}

process.on('message', message => {
    if (message.pitEvent) {
        emitter.emit(message.pitEvent, ...message.args)
    }
})

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
                log.debug('Forwarding:', data.operation + '/wait')
                return await wrapLxdResponse(node, axios.get(node.endpoint + data.operation + '/wait', { httpsAgent: agent }))
            case 'error':
                log.debug('LXD error', data.error)
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
    log.debug(method, axiosConfig.url, data || '')
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

function getNodeInfo (node) {
    return lxdGet(node, '')
}

async function getHeadInfo () {
    if (headInfo) {
        return headInfo
    }
    return headInfo = await getNodeInfo(headNode)
}
exports.getHeadInfo = getHeadInfo

async function getHeadCertificate () {
    let info = await getHeadInfo()
    return info.environment && info.environment.certificate
}

function getUrl (node, resource) {
    return node.endpoint + '/1.0' + (resource ? ('/' + resource) : '')
}

async function getContainersOnNode (node) {
    let results = await lxdGet(node, 'containers')
    var containers = []
    for (let result of results) {
        let split = result.split('/')
        if (split.length > 0) {
            let container = split[split.length - 1]
            let containerInfo = parseContainerName(container)
            if (containerInfo && containerInfo[0] == node.id) {
                containers.push(container)
            }
        }
    }
    return containers
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
    return !err
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

function getDaemonHost (pitId) {
    return getDaemonName(pitId) + '.lxd'
}
exports.getDaemonHost = getDaemonHost

function getWorkerHost (pitId, node, index) {
    return getContainerName(node.id, pitId, index) + '.lxd'
}
exports.getWorkerHost = getWorkerHost

function getPitDir (pitId) {
    return path.join(config.dataRoot, 'pits', pitId + '')
}
exports.getPitDir = getPitDir

function getPitDirExternal (pitId) {
    return path.join(config.mountRoot, 'pits', pitId + '')
}
exports.getPitDirExternal = getPitDirExternal

async function createPit () {
    let pitId = await newPitId()
    let pitDir = getPitDir(pitId)
    await fs.mkdirp(pitDir)
    emit('pitCreated', pitId)
    return pitId
}
exports.createPit = createPit

async function deletePit (pitId) {
    await fs.remove(getPitDir(pitId))
    emit('pitDeleted', pitId)
}
exports.deletePit = deletePit

async function addContainer (containerName, imageHash, options) {
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
            server:      config.endpoint,
            protocol:    'lxd',
            certificate: cert,
            fingerprint: imageHash
        },
    }, options || {})
    await lxdPost(node, 'containers', containerConfig)
}

async function startPit (pitId, drives, workers) {
    try {
        emit('pitStarting', pitId)
        let pitDir = getPitDir(pitId)
        let daemonHash = (await lxdGet(headNode, 'images/aliases/snakepit-daemon')).target
        let workerHash = (await lxdGet(headNode, 'images/aliases/snakepit-worker')).target
        let physicalNodes = { [headNode.endpoint]: headNode }
        for (let worker of workers) {
            // we just need one virtual node representant of/on each physical node
            physicalNodes[worker.node.endpoint] = worker.node
        }
        let network
        let endpoints = Object.keys(physicalNodes)
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
            try {
                await lxdPost(physicalNodes[localEndpoint], 'networks', {
                    name: network,
                    config: tunnelConfig
                })
            } catch (ex) {
                log.error('PROBLEM CREATING NETWORK', network, ex)
                throw ex
            }
        })

        let daemonDevices = { 'pit': { path: '/data/pit', source: getPitDirExternal(pitId), type: 'disk' } }
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
        await addContainer(
            daemonContainerName, 
            daemonHash, 
            { 
                devices: daemonDevices,
                config: { 'raw.idmap': 'both ' + config.mountUid + ' 2525' }
            }
        )
        await Parallel.each(workers, async function createWorker(worker) {
            let index = workers.indexOf(worker)
            let containerName = getContainerName(worker.node.id, pitId, index)
            let workerDevices = {}
            if (network) {
                workerDevices['eth0'] = { nictype: 'bridged', parent: network, type: 'nic' }
            }
            let workerDir = path.join(pitDir, 'workers', '' + index)
            await fs.mkdirp(workerDir)
            if (worker.env) {
                await fs.writeFile(path.join(workerDir, 'env.sh'), utils.envToScript(worker.env, true))
            }
            if (worker.script) {
                await fs.writeFile(path.join(workerDir, 'script.sh'), worker.script)
            }
            await addContainer(
                containerName, 
                workerHash, 
                assign({ devices: workerDevices }, worker.options || {})
            )
        })

        await Parallel.each(workers, async function (worker) {
            let containerName = getContainerName(worker.node.id, pitId, workers.indexOf(worker))
            await setContainerState(containerName, 'start')
        })
        await setContainerState(daemonContainerName, 'start')
        emit('pitStarted', pitId)
    } catch (ex) {
        emit('pitStartFailed', pitId)
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
    let pitDir = getPitDir(pitId)
    if (await fs.pathExists(pitDir)) {
        let [errLog, pitLog] = await to(fs.readFile(path.join(pitDir, 'pit.log')))
        let workersDir = path.join(pitDir, 'workers')
        let [errWorkers, workers] = await to(fs.readdir(workersDir))
        let [errResults, workerResults] = await to(Parallel.map(workers || [], async worker => {
            let workerDir = path.join(workersDir, worker)
            let [errStatus, statusContent] = await to(fs.readFile(path.join(workerDir, 'status')))
            let status = statusContent ? Number(statusContent.toString()) : 1
            let [errResult, resultContent] = await to(fs.readFile(path.join(workerDir, 'result')))
            let result = resultContent ?        resultContent.toString()  : ''
            return { status: status, result: result }
        }))
        return { log: (pitLog || '').toString(), workers: workerResults || []}
    } else {
        return { log: 'No pit directory', workers: [] }
    }
}

async function stopPit (pitId) {
    emit('pitStopping', pitId)
    let results = await extractResults(pitId) 
    let nodes = getAllNodes()
    for (let node of nodes) {
        let [err, containers] = await to(getContainersOnNode(node))
        if (containers) {
            for (let containerName of containers) {
                let containerInfo = parseContainerName(containerName)
                if (containerInfo && containerInfo[1] == pitId) {
                    let [errStop] = await to(setContainerState(containerName, 'stop', true))
                    let [errDelete] = await to(lxdDelete(node, 'containers/' + containerName))
                }
            }
        }
    }
    await to(Parallel.each(nodes, async node => {
        await to(lxdDelete(node, 'networks/' + snakepitPrefix + pitId))
    }))
    emit('pitStopped', pitId, results)
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
    return nodes
}
exports.getAllNodes = getAllNodes

function getNodeById (nodeId) {
    return nodeId == 'head' ? headNode : db.nodes[nodeId]
}
exports.getNodeById = getNodeById

async function authenticateNode(node, password) {
    if (node.endpoint == headNode.endpoint) {
        return
    }
    await lxdPost(node, 'certificates', { type: 'client', password: password })
}

async function unauthenticateNode(node) {
    if (node.endpoint == headNode.endpoint) {
        return
    }
    let certificates = await lxdGet(node, 'certificates')
    certificates = certificates.map(c => {
        c = c.split('/')
        return c[c.length - 1]
    })
    await Parallel.each(certificates, async c => {
        let cpath = 'certificates/' + c
        let cinfo = await lxdGet(node, cpath)
        if (cinfo.certificate == config.lxdCert) {
            await lxdDelete(node, cpath)
        }
    })
}

async function addNode (id, endpoint, password) {
    let newNode = { 
        id: id,
        endpoint: endpoint,
        resources: []
    }
    db.nodes[id] = newNode
    let pitId = await createPit()
    try {
        await authenticateNode(newNode, password)
        let result = await runPit(pitId, {}, [{ 
            node:    newNode,
            devices: { 'gpu': { type: 'gpu' } },
            script:  utils.getScript('scan.sh')
        }])
        let workers = result.workers
        if (workers.length > 0) {
            log.debug('ADDING NODE', id, workers)
            for (let line of workers[0].result.split('\n')) {
                let match = resourceParser.exec(line)
                if (match) {
                    let resource = { 
                        type:  match[1],  
                        name:  match[3],
                        index: Number(match[2])
                    }
                    newNode.resources.push(resource)
                    log.debug('FOUND RESOURCE', id, resource)
                }
            }
            db.nodes[id] = newNode
            return db.nodes[id]
        } else {
            throw new Error('Node scanning failed')
        }
    } catch (ex) {
        log.debug('ADDING NODE FAILED', ex)
        if (db.nodes[id]) {
            removeNode(db.nodes[id])
        }
        throw ex
    } finally {
        await to(deletePit(pitId))
    }
}
exports.addNode = addNode

async function removeNode (node) {
    setNodeState(node, nodeStates.OFFLINE)
    await to(unauthenticateNode(node))
    delete db.nodes[node.id]
}
exports.removeNode = removeNode

function setNodeState(node, nodeState) {
    if (node.state != nodeState) {
        log.debug('BOA')
        node.state = nodeState
        node.since = new Date().toISOString()
        emit('state', node.id, node.state)
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
            let dbnode = db.nodes[id]
            if (dbnode) {
                res.status(400).send({ message: 'Node with same id already registered' })
            } else if (node.endpoint && node.password) {
                addNode(id, node.endpoint, node.password).then(newNode => {
                    setNodeState(newNode, nodeStates.ONLINE)
                    res.status(200).send()
                }).catch(err => {
                    res.status(400).send({ message: 'Problem adding node:\n' + err })
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
                endpoint:    node.endpoint,
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
                removeNode(node)
                    .then(() => res.status(404).send())
                    .catch(err => res.status(500).send({ message: 'Problem removing node:\n' + err }))
            } else {
                res.status(404).send()
            }
        } else {
            res.status(403).send()
        }
    })
}

async function tick () {
    let nodes = getAllNodes()
    await to(Parallel.each(nodes, async node => {
        let [infoErr, info] = await to(getNodeInfo(node))
        if (infError) log.debug(infError)
        if (info) {
            setNodeState(node, nodeStates.ONLINE)
        } else {
            setNodeState(node, nodeStates.OFFLINE)
        }
    }))
    let [err, pits] = await to(getPits())
    emit('pitReport', pits)
    await Parallel.each(pits, async pitId => {
        if (await pitRequestedStop(pitId)) {  
            await stopPit(pitId)
        }
    })
}

exports.tick = function () {
    let goon = () => setTimeout(exports.tick, config.pollInterval)
    tick().then(goon).catch(goon)
}
