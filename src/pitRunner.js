const fs = require('fs-extra')
const path = require('path')
const https = require('https')
const axios = require('axios')
const assign = require('assign-deep')
const Parallel = require('async-parallel')

const log = require('./logger.js')
const store = require('./store.js')
const config = require('./config.js')
const clusterEvents = require('./utils/clusterEvents.js')
const { to, getScript, envToScript } = require('./utils/utils.js')

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

var headInfo
var db = store.root
var agent = new https.Agent({ 
    key: config.clientKey, 
    cert: config.clientCert,
    rejectUnauthorized: false
})

const nodeStates = {
    OFFLINE: 0,
    ONLINE:  1
}
exports.nodeStates = nodeStates

const headNode = { id: 'head', endpoint: config.endpoint }
exports.headNode = headNode

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
        data: data,
        timeout: 2000
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

function pitRequestedStop (pitId) {
    return fs.pathExists(path.join(getPitDir(pitId), 'stop'))
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
    return '/data/pits/' + pitId
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
    clusterEvents.emit('pitCreated', pitId)
    return pitId
}
exports.createPit = createPit

async function deletePit (pitId) {
    await fs.remove(getPitDir(pitId))
    clusterEvents.emit('pitDeleted', pitId)
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
        clusterEvents.emit('pitStarting', pitId)
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
                log.error('PROBLEM CREATING NETWORK', network, ex.toString())
                throw ex
            }
        })

        let daemonDevices = { 'pit': { path: '/data/rw/pit', source: getPitDirExternal(pitId), type: 'disk' } }
        if (network) {
            daemonDevices['eth0'] = { nictype: 'bridged', parent: network, type: 'nic' }
        }
        if (drives) {
            for (let dest of Object.keys(drives)) {
                daemonDevices[dest] = {
                    path:   dest,
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
                await fs.writeFile(path.join(workerDir, 'env.sh'), envToScript(worker.env, true))
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
        clusterEvents.emit('pitStarted', pitId)
    } catch (ex) {
        clusterEvents.emit('pitStartFailed', pitId)
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
    clusterEvents.emit('pitStopping', pitId)
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
    clusterEvents.emit('pitStopped', pitId, results)
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
            script:  getScript('scan.sh')
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
        node.state = nodeState
        node.since = new Date().toISOString()
        clusterEvents.emit('state', node.id, node.state)
    }
}

async function tick () {
    let nodes = getAllNodes()
    await to(Parallel.each(nodes, async node => {
        let [infoErr, info] = await to(getNodeInfo(node))
        if (infoErr) {
            log.error('PROBLEM ACCESSING NODE ' + node.id, infoErr.toString())
        }
        if (info) {
            setNodeState(node, nodeStates.ONLINE)
        } else {
            setNodeState(node, nodeStates.OFFLINE)
        }
    }))
    let [err, pits] = await to(getPits())
    clusterEvents.emit('pitReport', pits)
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
