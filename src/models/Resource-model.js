const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Group = require('./Group-model.js')
const User = require('./User-model.js')

var Resource = sequelize.define('resource', {
    id:         { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
    type:       { type: Sequelize.STRING,  allowNull: false },
    index:      { type: Sequelize.INTEGER, allowNull: false },
    name:       { type: Sequelize.STRING,  allowNull: false }
})

var ResourceGroup = Resource.ResourceGroup = sequelize.define('resourcegroup')
Resource.belongsToMany(Group, { through: ResourceGroup })
Group.belongsToMany(Resource, { through: ResourceGroup })

User.prototype.canAccessResource = async (resource) => {
    if (await resource.countGroups() == 0) {
        return true
    }
    return (await Resource.count({ 
        where: { id: resource.id }, 
        include: [
            { model: ResourceGroup },
            { model: User.UserGroup },
            { model: User, where: { id: this.id } }
        ]
    }) > 0)
}

module.exports = Resource
