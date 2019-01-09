const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Group = require('./Group-model.js')

var Resource = sequelize.define('resource', {
    id:         { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    type:       { type: Sequelize.STRING,  allowNull: false },
    index:      { type: Sequelize.INTEGER, allowNull: false },
    name:       { type: Sequelize.STRING,  allowNull: false }
})

User.belongsToMany(Group, { through: 'ResourceGroup' })
Group.belongsToMany(User, { through: 'ResourceGroup' })

User.prototype.canAccessResource = async (resource) => {
    // TODO: Implement DB based decision
    /*
    if (resource.groups) {
        if (this.groups) {
            for (let group of this.groups) {
                if (resource.groups.includes(group)) {
                    return true
                }
            }
        }
        return false
    }
    */
    return true
}

module.exports = Resource
