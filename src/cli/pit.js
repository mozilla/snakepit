#! /usr/bin/env node
const program = require('commander')

program
    .version('0.1.0')
 
program
    .command('run')
    .description('enqueues current directory as new job')
    .option("-w, --watch", "immediately starts watching the job")
    .action(function(options) {
        var watch = options.watch
    })
 
program.parse(process.argv)