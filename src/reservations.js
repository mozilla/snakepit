const { MultiRange } = require('multi-integer-range')

const store = require('./store.js')
const config = require('./config.js')
const groupsModule = require('./groups.js')
const { nodeStates } = require('./nodes.js')

var exports = module.exports = {}

var db = store.root

function _isReserved(clusterReservation, nodeId, resourceId) {
    return [].concat.apply([], clusterReservation).reduce(
        (result, reservation) =>
            result || (
                reservation.node == nodeId &&
                reservation.resources.hasOwnProperty(resourceId)
            ),
        false
    )
}

function _reserveProcessOnNode(node, clusterReservation, resourceList, user, simulation) {
    var nodeReservation = { node: node.id, resources: {} }
    if (!node || !node.resources) {
        return null
    }
    var resourceCounter = 1
    let reserveNumeric = function(type, minIndex, maxIndex, numResources) {
        for(let i = minIndex; resourceCounter > 0 && i <= maxIndex; i++) {
            let resourceId = type + i
            let nodeResource = node.resources[resourceId]
            if (!_isReserved(clusterReservation, node.id, resourceId) &&
                (!nodeResource || !nodeResource.job || simulation)
            ) {
                nodeReservation.resources[resourceId] = {
                    type: 'num:' + type,
                    index: i
                }
                resourceCounter--
            }
        }
    }
    reserveNumeric('proc', 0, config.maxProcesses, 1)
    if (resourceCounter > 0) {
        return null
    }
    for (let resource of resourceList) {
        resourceCounter = resource.count
        //console.log('Looking for ' + resource.count + ' x ' + resource.name)
        if (resource.name == 'port') {
            reserveNumeric('port', 1024, 65535, resource.count)
        } else {
            let name = db.aliases[resource.name] ? db.aliases[resource.name].name : resource.name
            for(let resourceId of Object.keys(node.resources)) {
                //console.log('Testing ' + resourceId)
                if (resourceCounter > 0) {
                    let nodeResource = node.resources[resourceId]
                    if (nodeResource.name == name &&
                        !_isReserved(clusterReservation, node.id, resourceId) &&
                        (!nodeResource.job || simulation) &&
                        groupsModule.canAccessResource(user, nodeResource)
                    ) {
                        nodeReservation.resources[resourceId] = {
                            type: nodeResource.type,
                            index: nodeResource.index
                        }
                        resourceCounter--
                    }
                }
            }
        }
        if (resourceCounter > 0) {
            return null
        }
    }
    return nodeReservation
}

function _reserveProcess(clusterReservation, resourceList, user, simulation) {
    for (let nodeId of Object.keys(db.nodes)) {
        let node = db.nodes[nodeId]
        if (node.state == nodeStates.ONLINE || simulation) {
            let nodeReservation = _reserveProcessOnNode(node, clusterReservation, resourceList, user, simulation)
            if (nodeReservation) {
                return nodeReservation
            }
        }
    }
    return null
}

exports.reserveCluster = function(clusterRequest, user, simulation) {
    let clusterReservation = []
    for(let groupIndex = 0; groupIndex < clusterRequest.length; groupIndex++) {
        let groupRequest = clusterRequest[groupIndex]
        let groupReservation = []
        clusterReservation.push(groupReservation)
        for(let processIndex = 0; processIndex < groupRequest.count; processIndex++) {
            let processReservation = _reserveProcess(clusterReservation, groupRequest.process, user, simulation)
            if (processReservation) {
                processReservation.groupIndex = groupIndex
                processReservation.processIndex = processIndex
                groupReservation.push(processReservation)
            } else {
                return null
            }
        }
    }
    return clusterReservation
}

exports.summarizeClusterReservation = function(clusterReservation) {
    if (!clusterReservation) {
        return
    }
    let nodes = {}
    for(let groupReservation of clusterReservation) {
        for(let processReservation of groupReservation) {
            nodes[processReservation.node] =
                Object.assign(
                    nodes[processReservation.node] || {},
                    processReservation.resources
                )
        }
    }
    let summary = ''
    for(let nodeId of Object.keys(nodes)) {
        let nodeResources = nodes[nodeId]
        if (summary != '') {
            summary += ' + '
        }
        summary += nodeId + '['
        let first = true
        for(let type of
            Object.keys(nodeResources)
            .map(r => nodeResources[r].type)
            .filter((v, i, a) => a.indexOf(v) === i) // make unique
        ) {
            let resourceIndices =
                Object.keys(nodeResources)
                .map(r => nodeResources[r])
                .filter(r => r.type == type)
                .map(r => r.index)
            if (resourceIndices.length > 0) {
                if (!first) {
                    summary += ' + '
                }
                summary += type + ' ' + new MultiRange(resourceIndices.join(',')).getRanges()
                    .map(range => range[0] == range[1] ? range[0] : range[0] + '-' + range[1])
                    .join(',')
                first = false
            }
        }
        summary += ']'
    }
    return summary
}