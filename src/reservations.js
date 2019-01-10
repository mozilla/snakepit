const { MultiRange } = require('multi-integer-range')

var exports = module.exports = {}

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

function _reserveProcess(node, clusterReservation, resourceList, user, simulation) {
    if (!node || !node.resources) {
        return null
    }
    let nodeReservation = { node: node.id, resources: {} }
    for (let resource of resourceList) {
        let resourceCounter = resource.count
        //console.log('Looking for ' + resource.count + ' x ' + resource.name)
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
        if (resourceCounter > 0) {
            return null
        }
    }
    return nodeReservation
}

exports.reserveCluster = function(clusterRequest, user, simulation) {
    let quotients = {}
    let aq = node => {
        if (quotients.hasOwnProperty(node.id)) {
            return quotients[node.id]
        }
        let resources = Object.keys(node.resources).map(k => node.resources[k])
        let allocated = resources.filter(resource => !!resource.job)
        return quotients[node.id] = resources.length / (allocated.length + 1)
    }
    let nodes = Object.keys(db.nodes)
        .map(k => db.nodes[k])
        .filter(node => node.state == nodesModule.nodeStates.ONLINE || simulation)
        .sort((a, b) => aq(a) - aq(b))
    let clusterReservation = []
    for(let groupIndex = 0; groupIndex < clusterRequest.length; groupIndex++) {
        let groupRequest = clusterRequest[groupIndex]
        let groupReservation = []
        clusterReservation.push(groupReservation)
        for(let processIndex = 0; processIndex < groupRequest.count; processIndex++) {
            let processReservation
            for (let node of nodes) {
                processReservation = _reserveProcess(node, clusterReservation, groupRequest.process, user, simulation)
                if (processReservation) {
                    break
                }
            }
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

exports.fulfillReservation = function (clusterReservation, jobId) {
    for (let groupReservation of clusterReservation) {
        for (let reservation of groupReservation) {
            let node = db.nodes[reservation.node]
            for(let resourceId of Object.keys(reservation.resources)) {
                let resource = node.resources[resourceId]
                resource.job = jobId
            }
        }
    }
}

exports.freeReservation = function (clusterReservation) {
    for (let groupReservation of clusterReservation) {
        for (let reservation of groupReservation) {
            let node = db.nodes[reservation.node]
            for(let resourceId of Object.keys(reservation.resources)) {
                let resource = node.resources[resourceId]
                if (resource) {
                    delete resource.job
                }
            }
        }
    }
}

exports.summarizeClusterReservation = function(clusterReservation, skipNumerical) {
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
            .filter(v => !v.startsWith('num:') || !skipNumerical)
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