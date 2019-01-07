const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Group = require('./Group-model.js')

var Job = sequelize.define('job', {
    title: {
        type: Sequelize.STRING,
        allowNull: false
    },
    request: {
        type: Sequelize.STRING,
        allowNull: false
    }
})

Job.belongsToMany(Group, { through: 'JobGroup' })
Group.belongsToMany(Job, { through: 'JobGroup' })

module.exports = Job
