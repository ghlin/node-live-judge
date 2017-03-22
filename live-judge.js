#!/usr/bin/env node

;
var _, buildCompileArgs, byline, chokidar, colors, compileSync, compiler, diffLines, extractOption, extractOptionsFromFile, extractOptionsFromLines, extractTestings, fs, groupOptions, inspect, path, program, runSync, runTestSync, selectNth, spawnSync, translate, watchdir, watcher;

_ = require('underscore');

byline = require('byline');

chokidar = require('chokidar');

colors = require('colors');

fs = require('fs');

path = require('path');

diffLines = require('diff').diffLines;

inspect = require('util').inspect;

spawnSync = require('child_process').spawnSync;

program = require('commander');

program.version('0.0.1').option('-c, --compiler [compiler]', 'set compiler', 'clang++').option('-w, --watchdir [dir]', 'watch dir', process.cwd()).parse(process.argv);

compiler = program.compiler || 'g++';

watchdir = program.watchdir || process.cwd();

extractOption = function(line) {
  var matches, pattern, ref;
  pattern = /@@@\s*(.+)(:\s*(.+)|\.)$/;
  matches = pattern.exec(line);
  if (matches != null) {
    return [matches[1].trim(), matches[2][0], (ref = matches[3]) != null ? ref.trim() : void 0, matches.index];
  } else {
    return void 0;
  }
};

translate = function(line) {
  return line.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\\\/g, '\\');
};

extractOptionsFromLines = function(fullPath, lines) {
  var baseDir, fixPath, reduceResult, reducer;
  baseDir = path.dirname(fullPath);
  fixPath = function(file) {
    return baseDir + '/' + file;
  };
  reducer = function(acc, line) {
    var content, decomposed, file, initPos, k, key, leader, nextK, option, options, ref, ref1, slicedLine, value;
    options = acc[0], k = acc[1];
    decomposed = void 0;
    if ((k != null ? k.testingSectionWithTerm : void 0) != null) {
      ref = k.testingSectionWithTerm, lines = ref[0], key = ref[1], value = ref[2], initPos = ref[3];
      slicedLine = translate(line.slice(initPos));
      if (slicedLine === value) {
        option = [key, lines.join('\n')];
        options.push(option);
        return [options, null];
      } else {
        decomposed = extractOption(line);
        if ((decomposed != null) || line.length <= initPos) {
          if (lines.length === 0) {
            options.push([key, translate(value)]);
          } else {
            options.push([key, lines.join('\n')]);
          }
        }
        if ((decomposed == null) && line.length <= initPos) {
          return [options, {}];
        }
        if (decomposed == null) {
          lines.push(slicedLine);
          return acc;
        }
      }
    } else if ((k != null ? k.testingSectionNoTerm : void 0) != null) {
      ref1 = k.testingSectionNoTerm, lines = ref1[0], key = ref1[1], initPos = ref1[2];
      decomposed = extractOption(line);
      slicedLine = translate(line.slice(initPos));
      if ((decomposed == null) || slicedLine.length === 0) {
        lines.push(slicedLine);
        return [options, k];
      } else {
        options.push([key, lines.join('\n')]);
      }
    } else {
      decomposed = extractOption(line);
    }
    if (decomposed == null) {
      return acc;
    }
    key = decomposed[0], leader = decomposed[1], value = decomposed[2], initPos = decomposed[3];
    if (key === 'in' || key === 'out') {
      if (leader === ':' && value[0] === '@') {
        file = fixPath(value.slice(1));
        content = fs.readFileSync(file, 'utf-8');
        options.push([key, content]);
        return [options, {}];
      } else {
        nextK = {};
        if (leader === '.') {
          nextK.testingSectionNoTerm = [[], key, initPos];
        } else {
          nextK.testingSectionWithTerm = [[], key, value, initPos];
        }
        return [options, nextK];
      }
    } else {
      options.push([key, value]);
      return [options, {}];
    }
  };
  reduceResult = _.reduce(lines, reducer, [[], {}]);
  return reduceResult[0];
};

extractOptionsFromFile = function(file) {
  var content;
  content = fs.readFileSync(file, 'utf-8');
  return extractOptionsFromLines(file, content.split('\n'));
};

selectNth = function(i) {
  return function(a) {
    return a[i];
  };
};

extractTestings = function(options) {
  var reducer, result, testings;
  reducer = function(acc, option) {
    var g, h;
    h = acc[0], g = acc[1];
    if (option[0] === 'in') {
      h.push(g);
      g = [];
    }
    g.push(option);
    return [h, g];
  };
  result = _.reduce(options.concat([['in', void 0]]), reducer, [[], []]);
  testings = _.filter(result[0], function(x) {
    return x[0][0] === 'in';
  });
  return _.map(testings, function(testCase) {
    var ref;
    return {
      "in": testCase[0][1],
      out: (ref = testCase[1]) != null ? ref[1] : void 0
    };
  });
};

groupOptions = function(options) {
  var g;
  g = _.groupBy(options, selectNth(0));
  return _.mapObject(g, function(val, key) {
    return _.map(val, selectNth(1));
  });
};

buildCompileArgs = function(optGroups, fullPath, defaultOutput) {
  var flags, output;
  if (defaultOutput == null) {
    defaultOutput = fullPath + '.exec';
  }
  flags = (optGroups['compile'] || ['-std=c++1y']).join(' ');
  output = (optGroups['output'] || [defaultOutput])[0];
  return [[fullPath, flags, '-o', output, '-fcolor-diagnostics'], output];
};

compileSync = function(optGroups, fullPath) {
  var args, compileProcess, compilerOverride, output, ref, ref1;
  ref = buildCompileArgs(optGroups, fullPath), args = ref[0], output = ref[1];
  compilerOverride = (ref1 = optGroups['compiler']) != null ? ref1[0] : void 0;
  compilerOverride || (compilerOverride = compiler);
  compileProcess = spawnSync(compilerOverride, args);
  if (compileProcess.status !== 0) {
    console.log(("*** Error compiling " + fullPath).red);
    process.stdout.write(compileProcess.stderr.toString('utf-8'));
    process.stdout.write('\n');
    return console.log(("*** at " + (new Date)).red);
  } else {
    return output;
  }
};

runTestSync = function(execPath, testInput, testOutput) {
  var color, diff, execProcess, formattedLines, ok, output, reducer, ref;
  execProcess = spawnSync(execPath, [], {
    input: testInput
  });
  output = execProcess.stdout.toString('utf-8');
  diff = diffLines(output, testOutput, {
    newLineIsToken: true
  });
  reducer = function(acc, part) {
    if (part.added != null) {
      return [acc[0] + part.value.blue, false];
    } else if (part.removed != null) {
      return [acc[0] + part.value.red, false];
    } else {
      return [acc[0] + part.value.grey, acc[1]];
    }
  };
  ref = _.reduce(diff, reducer, ["", true]), formattedLines = ref[0], ok = ref[1];
  if (ok) {
    console.log("*** Passed!".green);
  } else {
    console.log("*** Failed!".red);
    process.stdout.write(formattedLines);
    process.stdout.write('\n');
    console.log("*** Good luck then...".red);
  }
  color = execProcess.status === 0 ? 'grey' : 'red';
  return console.log(("*** Process returned: " + execProcess.status + " at " + (new Date))[color]);
};

runSync = function(execPath) {
  var color, execProcess;
  execProcess = spawnSync(execPath, []);
  process.stdout.write(execProcess.stdout.toString('utf-8'));
  process.stdout.write((execProcess.stderr.toString('utf-8')).red);
  color = execProcess.status === 0 ? 'grey' : 'red';
  return console.log(("*** Process returned: " + execProcess.status + " at " + (new Date))[color]);
};

watcher = chokidar.watch(watchdir + "/**/*.cc", {
  ignoreInitial: true
});

console.log(("*** Watching dir: " + watchdir).grey);

watcher.on('all', function(evt, fullPath) {
  var i, j, len, optGroups, options, output, results, testCase, tests;
  if (evt === 'unlink') {
    return;
  }
  if (!path.isAbsolute(fullPath)) {
    fullPath = process.cwd() + '/' + fullPath;
  }
  options = extractOptionsFromFile(fullPath);
  optGroups = groupOptions(options);
  output = compileSync(optGroups, fullPath);
  if (output == null) {
    return console.log("*** Wait for changes...".grey);
  }
  tests = extractTestings(options);
  if (tests.length !== 0) {
    results = [];
    for (i = j = 0, len = tests.length; j < len; i = ++j) {
      testCase = tests[i];
      console.log(("*** Running test #" + (i + 1) + "...").grey);
      results.push(runTestSync(output, testCase['in'], testCase['out']));
    }
    return results;
  } else {
    return runSync(output);
  }
});
