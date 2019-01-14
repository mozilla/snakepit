const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Resource = require('./Resource-model.js')

var Node = sequelize.define('node', {
    id:         { type: Sequelize.STRING,  primaryKey: true },
    endpoint:   { type: Sequelize.STRING,  allowNull: false },
    password:   { type: Sequelize.STRING,  allowNull: true },
    online:     { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    available:  { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    since:      { type: Sequelize.DATE,    allowNull: false }
})

Node.hasMany(Resource)

async function authenticateNode(node, password) {
    if (node.endpoint == headNode.endpoint) {
        return
    }
    await lxd.post(node.endpoint, 'certificates', { type: 'client', password: password })
}

async function unauthenticateNode(node) {
    if (node.endpoint == headNode.endpoint) {
        return
    }
    let certificates = await lxd.get(node.endpoint, 'certificates')
    certificates = certificates.map(c => {
        c = c.split('/')
        return c[c.length - 1]
    })
    await Parallel.each(certificates, async c => {
        let cpath = 'certificates/' + c
        let cinfo = await lxd.get(node.endpoint, cpath)
        if (cinfo.certificate == config.lxdCert) {
            await lxd.delete(node.endpoint, cpath)
        }
    })
}

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

Node.startup = () => {
    //Node.update({ online: false, since: Date.now() })
}

module.exports = Node
