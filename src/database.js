const sqlite3 = require('sqlite3')
const config = require('./config.js')

module.exports = new sqlite3.Database(
    config.dbPath,
    sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
    err => {
        console.error('Problem opening database file "' + config.dbPath + '"')
        console.error(err)
        process.exit(1)
    }
)
