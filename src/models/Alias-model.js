const Sequelize = require('sequelize')
const sequelize = require('./db.js')

var Alias = sequelize.define('alias', {
    id: Sequelize.STRING,
    name: Sequelize.STRING
})

Alias.getAlias = async name => {
    let entry = await Alias.findOne({ where: { name: name } }, { rejectOnEmpty: false })
    return entry && entry.alias
}

module.exports = Alias
