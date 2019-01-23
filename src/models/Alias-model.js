const Sequelize = require('sequelize')
const sequelize = require('./db.js')

var Alias = sequelize.define('alias', {
    id:           { type: Sequelize.STRING, allowNull: false, primaryKey: true },
    name:         { type: Sequelize.STRING, allowNull: false }
})

Alias.getAlias = async name => {
    let entry = await Alias.findOne({ where: { name: name } })
    return entry && entry.id
}

module.exports = Alias
