_             = require 'underscore'
chokidar      = require 'chokidar'
colors        = require 'colors'
fs            = require 'fs'
path          = require 'path'
{ diffLines } = require 'diff'
{ spawnSync } = require 'child_process'
program       = require 'commander'


# {{{ program options

program.version '0.0.1'
  .option '-c, --compiler [compiler]', 'set compiler', 'clang++'
  .option '-w, --watchdir [dir]', 'watch dir', process.cwd()
  .option '-r, --run-only', 'run code only', false
  .parse process.argv

compiler = program.compiler
watchdir = program.watchdir
runOnly  = program.runOnly

if watchdir[watchdir.length - 1] == '/'
  watchdir = watchdir.slice 0, watchdir.length - 1

# }}}




# {{{ extractOption
extractOption = (line) ->
  pattern = /@@@\s*(.+)(:\s*(.+)|\.)$/
  matches = pattern.exec line

  if matches?
    return [ matches[1].trim(), matches[2][0], matches[3]?.trim(), matches.index ]
  else
    return undefined
# }}}

# {{{ extractOption

translate = (line) ->
  line.replace /\\n/g, '\n'
    .replace /\\t/g, '\t'
    .replace /\\r/g, '\r'
    .replace /\\\\/g, '\\'

extractOptionsFromLines = (fullPath, lines) ->
  baseDir = path.dirname fullPath
  fixPath = (file) ->
    if not path.isAbsolute
      baseDir + '/' + file
    else
      file

  reducer = (acc, line) ->
    [options, k] = acc
    decomposed   = undefined

    if k?.testingSectionWithTerm?
      [lines, key, value, initPos] = k.testingSectionWithTerm

      slicedLine = translate line.slice initPos

      if slicedLine == value
        option = [key, lines.join '\n']
        options.push option
        return [options, null]
      else
        decomposed = extractOption line

        if decomposed? or line.length <= initPos
          if lines.length == 0
            options.push [key, translate value]
          else
            options.push [key, lines.join '\n']

        if not decomposed? and line.length <= initPos
          return [options, {}]

        if not decomposed?
          lines.push slicedLine
          return acc

    else if k?.testingSectionNoTerm?
      [lines, key, initPos] = k.testingSectionNoTerm

      decomposed = extractOption line
      slicedLine = translate line.slice initPos

      if not decomposed? or slicedLine.length == 0
        lines.push slicedLine
        return [options, k]
      else
        options.push [key, lines.join '\n']
    else
      decomposed = extractOption line

    if not decomposed?
      return acc

    [ key, leader, value, initPos ] = decomposed

    if key == 'in' or key == 'out' or key == 'stdin'
      if leader == ':' && value[0] == '@'
        file = fixPath value.slice 1
        # TODO: catch IO exceptions here.
        content = fs.readFileSync file, 'utf-8'
        options.push [key, content]
        return [options, {}]
      else
        nextK = {}

        if leader == '.'
          nextK.testingSectionNoTerm   = [[], key, initPos]
        else
          nextK.testingSectionWithTerm = [[], key, value, initPos]

        return [options, nextK]
    else
      options.push [key, value]
      return [options, {}]

  reduceResult = _.reduce lines, reducer, [[], {}]
  # assert reduceResult[1] is {}
  reduceResult[0]

extractOptionsFromFile = (file) ->
  content = fs.readFileSync file, 'utf-8'
  extractOptionsFromLines file, content.split '\n'

# }}}


# {{{ analyse
selectNth = (i) -> (a) -> a[i]


extractTestings = (options) ->
  reducer = (acc, option) ->
    [h, g] = acc

    if option[0] == 'in'
      h.push g
      g = []

    g.push option
    return [h, g]

  result = _.reduce (options.concat [['in', undefined]]), reducer, [[], []]

  testings = _.filter result[0], (x) -> x[0]?[0] == 'in'
  _.map testings, (testCase) ->
    in:  testCase[0]?[1]
    out: testCase[1]?[1]

groupOptions = (options) ->
  g = _.groupBy options, selectNth 0
  _.mapObject g, (val, key) ->
    _.map val, selectNth 1

# }}}


buildCompileArgs = (optGroups, fullPath, defaultOutput = fullPath + '.exe') ->
  flags     = optGroups['compile']    or ['-std=c++1y']
  output    = optGroups['output']?[0] or defaultOutput

  flags     = _.flatten _.map flags, (flag) -> flag.split ' '

  args = [ fullPath, '-o', output ]
    .concat flags
    .concat [ '-fcolor-diagnostics' ]

  [ args, output ]

compileSync = (optGroups, fullPath) ->
  [args, output]   =   buildCompileArgs optGroups, fullPath
  compilerOverride =   optGroups['compiler']?[0]
  compilerOverride or= compiler

  compileProcess = spawnSync compilerOverride, args

  if compileProcess.status != 0
    console.log "*** Error compiling #{ fullPath }".red
    process.stdout.write compileProcess.stderr.toString 'utf-8'
    process.stdout.write '\n'
    console.log "*** at #{ new Date }".red
  else
    warnings = compileProcess.stderr.toString 'utf-8'

    if warnings.length >= 3 # magic!!!
      console.log "*** Warnings:".yellow
      process.stdout.write warnings
      process.stdout.write '\n'
      console.log "*** at #{ new Date }".yellow

    output

runTestSync = (execPath, testInput, testOutput) ->
  execProcess = spawnSync execPath, [],
    input: testInput

  if not execProcess.status?
    console.log "??? #{ require('util').inspect execProcess, depth: null }".red
    return

  output = execProcess.stdout.toString 'utf-8'

  diff = diffLines output, testOutput, newLineIsToken: true

  reducer = (acc, part) ->
    if part.added?
      [acc[0] + part.value.blue, false]
    else if part.removed?
      [acc[0] + part.value.red, false]
    else
      [acc[0] + part.value.grey, acc[1]]

  [formattedLines, ok] = _.reduce diff, reducer, ["", true]

  if ok
    console.log "*** Passed!".green
  else
    console.log "*** Failed!".red
    process.stdout.write formattedLines
    process.stdout.write '\n'
    console.log "*** Good luck then...".red

  color = if execProcess.status == 0 then 'grey' else 'red'
  console.log "*** Process returned: #{ execProcess.status } at #{ new Date }"[color]


runSync = (execPath, input) ->
  execProcess = spawnSync execPath, [],
    input: input

  if not execProcess.status?
    console.log "??? #{ require('util').inspect execProcess, depth: null }".red
    return

  process.stdout.write execProcess.stdout.toString 'utf-8'
  process.stdout.write (execProcess.stderr.toString 'utf-8').red

  color = if execProcess.status == 0 then 'grey' else 'red'
  console.log "*** Process returned: #{ execProcess.status } at #{ new Date }"[color]

watcher = chokidar.watch "#{ watchdir }/**/*.cc",
  ignoreInitial: true

console.log "*** Watching dir: #{ watchdir }".grey
watcher.on 'all', (evt, fullPath) ->
  if evt == 'unlink'
    return

  if !path.isAbsolute fullPath
    fullPath = process.cwd() + '/' + fullPath

  options   = extractOptionsFromFile fullPath
  optGroups = groupOptions options

  output = compileSync optGroups, fullPath

  if not output?
    return console.log "*** Wait for changes...".grey

  tests = extractTestings options

  if tests.length != 0 and not runOnly and not optGroups['run-only']?
    for testCase, i in tests
      console.log "*** Running test ##{ i + 1 }...".grey

      runTestSync output, testCase['in'], testCase['out']
  else
    inputs = optGroups['stdin'] or [""]
    for input, i in inputs
      console.log "*** Running with input ##{ i + 1 }...".grey

      runSync output, input

