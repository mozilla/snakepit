const Parallel = require('async-parallel')
const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Resource = require('./Resource-model.js')
const lxd = require('../utils/lxd.js')
const config = require('../config.js')

var Node = sequelize.define('node', {
    id:           { type: Sequelize.STRING,  primaryKey: true },
    endpoint:     { type: Sequelize.STRING,  allowNull: false },
    password:     { type: Sequelize.STRING,  allowNull: true },
    online:       { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    available:    { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    since:        { type: Sequelize.DATE,    allowNull: false }
})

Node.hasMany(Resource)
Resource.belongsTo(Node)

Node.beforeCreate(async node => {
    if (!(await Node.findOne({ where: { endpoint: node.endpoint } }))) {
        try {
            await lxd.post(node.endpoint, 'certificates', { type: 'client', password: node.password })
        } catch (ex) {
            if (!ex.response || !ex.response.data || !ex.response.data.error || 
                ex.response.data.error != 'Certificate already in trust store') {
                throw ex
            }
        }
    }
    delete node.password
})

Node.afterDestroy(async node => {
    if (node.endpoint != config.endpoint) {
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
})

module.exports = Node
