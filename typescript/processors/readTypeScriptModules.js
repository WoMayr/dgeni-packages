var glob = require('glob');
var path = require('canonical-path');
var _ = require('lodash');
var ts = require('typescript');

module.exports = function readTypeScriptModules(tsParser, modules, getFileInfo, ignoreTypeScriptNamespaces,
                                                getExportDocType, getExportAccessibility, getContent, createDocMessage, log) {

  return {
    $runAfter: ['files-read'],
    $runBefore: ['parsing-tags'],

    $validate: {
      sourceFiles: {presence: true},
      basePath: {presence: true},
      hidePrivateMembers: {inclusion: [true, false]},
      sortClassMembers: {inclusion: [true, false]},
      ignoreExportsMatching: {}
    },

    // A collection of globs that identify those modules for which we should create docs
    sourceFiles: [],
    // The base path from which to load the source files
    basePath: '.',
    // We can ignore members of classes that are private
    hidePrivateMembers: true,
    // We leave class members sorted in order of declaration
    sortClassMembers: false,
    // We can provide a collection of strings or regexes to ignore exports whose export names match
    ignoreExportsMatching: ['___esModule'],

    $process: function(docs) {

      // Convert ignoreExportsMatching to an array of regexes
      var ignoreExportsMatching = convertToRegexCollection(this.ignoreExportsMatching);

      var hidePrivateMembers = this.hidePrivateMembers;
      var sortClassMembers = this.sortClassMembers;

      var basePath = path.resolve(this.basePath);
      var filesPaths = expandSourceFiles(this.sourceFiles, basePath);
      var parseInfo = tsParser.parse(filesPaths, this.basePath);
      var moduleSymbols = parseInfo.moduleSymbols;

      // Iterate through each of the modules that were parsed and generate a module doc
      // as well as docs for each module's exports.
      moduleSymbols.forEach(function(moduleSymbol) {

        var moduleDoc = createModuleDoc(moduleSymbol, basePath);

        // Add this module doc to the module lookup collection and the docs collection
        modules[moduleDoc.id] = moduleDoc;
        docs.push(moduleDoc);

        // Iterate through this module's exports and generate a doc for each
        moduleSymbol.exportArray.forEach(function(exportSymbol) {

          // Ignore exports starting with an underscore
          if (anyMatches(ignoreExportsMatching, exportSymbol.name)) return;

          // If the symbol is an Alias then for most things we want the original resolved symbol
          var resolvedExport = exportSymbol.resolvedSymbol || exportSymbol;

          // If the resolved symbol contains no declarations then it is invalid
          // (probably an abstract class)
          // For the moment we are just going to ignore such exports
          // TODO: find a way of generating docs for them
          if (!resolvedExport.declarations) return;

          var exportDoc = createExportDoc(exportSymbol.name, resolvedExport, moduleDoc, basePath, parseInfo.typeChecker);
          log.debug('>>>> EXPORT: ' + exportDoc.name + ' (' + exportDoc.docType + ') from ' + moduleDoc.id);

          // Add this export doc to its module doc
          moduleDoc.exports.push(exportDoc);
          docs.push(exportDoc);

          exportDoc.members = [];
          exportDoc.statics = [];

          // Generate docs for each of the export's members
          resolvedExport.declarations.forEach(declaration => {

            if (declaration.members) {
              declaration.members.forEach(member => {
                const memberSymbol = member.symbol;
                if (!memberSymbol) return;

                const memberName = memberSymbol.name;
                // FIXME(alexeagle): why do generic type params appear in members?
                if (memberName === 'T') {
                  return;
                }
                log.silly('>>>>>> member: ' + memberName + ' from ' + exportDoc.id + ' in ' + moduleDoc.id);
                var memberDoc = createMemberDoc(memberSymbol, exportDoc, basePath, parseInfo.typeChecker);

                // We special case the constructor and sort the other members alphabetically
                if (memberSymbol.flags & ts.SymbolFlags.Constructor) {
                  exportDoc.constructorDoc = memberDoc;
                  docs.push(memberDoc);
                } else if (memberSymbol.name === '__call' && memberSymbol.flags & ts.SymbolFlags.Signature) {
                  docs.push(memberDoc);
                  exportDoc.callMember = memberDoc;
                } else if (memberSymbol.name === '__new' && memberSymbol.flags & ts.SymbolFlags.Signature) {
                  docs.push(memberDoc);
                  exportDoc.newMember = memberDoc;
                } else {
                  if (!hidePrivateMembers || (memberSymbol.name.charAt(0) !== '_' && memberDoc.accessibility !== 'private')) {
                    docs.push(memberDoc);
                    if(ts.getCombinedModifierFlags(memberSymbol.valueDeclaration) & ts.ModifierFlags.Static) {
                      exportDoc.statics.push(memberDoc);
                      memberDoc.isStatic = true;
                    } else {
                      exportDoc.members.push(memberDoc);
                    }
                  }
                }
              });
            }
          });

          if (exportDoc.docType === 'enum') {
            for(var memberName in resolvedExport.exports) {
              log.silly('>>>>>> member: ' + memberName + ' from ' + exportDoc.id + ' in ' + moduleDoc.id);
              var memberSymbol = resolvedExport.exports[memberName];
              var memberDoc = createMemberDoc(memberSymbol, exportDoc, basePath, parseInfo.typeChecker);
              docs.push(memberDoc);
              exportDoc.members.push(memberDoc);
            }
          } else if (resolvedExport.flags & ts.SymbolFlags.HasExports) {
            for (var exported in resolvedExport.exports) {
              if (exported === 'prototype') continue;
              if (hidePrivateMembers && exported.charAt(0) === '_') continue;
              var memberSymbol = resolvedExport.exports[exported];
              var memberDoc = createMemberDoc(memberSymbol, exportDoc, basePath, parseInfo.typeChecker);
              memberDoc.isStatic = true;
              docs.push(memberDoc);
              console.log('static export of export: ' + memberDoc.id + ' from ' + exportDoc.id + ' in ' + moduleDoc.id);
              exportDoc.statics.push(memberDoc);
            }
          }

          if (sortClassMembers) {
            exportDoc.members.sort(function(a, b) {
              if (a.name > b.name) return 1;
              if (a.name < b.name) return -1;
              return 0;
            });
            exportDoc.statics.sort(function(a, b) {
              if (a.name > b.name) return 1;
              if (a.name < b.name) return -1;
              return 0;
            });
          }
        });
      });
    }
  };


  function createModuleDoc(moduleSymbol, basePath) {
    var id = moduleSymbol.name.replace(/^"|"$/g, '').replace(/\/index$/, '');
    var name = id.split('/').pop();
    var moduleDoc = {
      docType: 'module',
      name: name,
      id: id,
      aliases: [id, name],
      moduleTree: moduleSymbol,
      content: getContent(moduleSymbol.valueDeclaration),
      exports: [],
      fileInfo: getFileInfo(moduleSymbol, basePath),
      location: getLocation(moduleSymbol.valueDeclaration)
    };
    return moduleDoc;
  }

  function createExportDoc(name, exportSymbol, moduleDoc, basePath, typeChecker) {
    var typeParamString = '';
    var heritageString = '';
    var typeDefinition = '';

    var declaration = exportSymbol.valueDeclaration || exportSymbol.declarations[0];
    var additionalDeclarations = exportSymbol.declarations.filter(function(d) { return declaration !== d; });

    var sourceFile = ts.getSourceFileOfNode(declaration);

    if (declaration.typeParameters) {
      typeParamString = '<' + getText(sourceFile, declaration.typeParameters) + '>';
    }

    if (declaration.symbol.flags & ts.SymbolFlags.TypeAlias) {
      var type = declaration.type;
      if (!type) {
        // this symbol is a type alias but also a value declaration
        // so we will search the additionalDeclarations for the type that is
        // being aliased.
        additionalDeclarations.some(function(decl) { return type = decl.type; });
      }
      typeDefinition = getText(sourceFile, type).trim();
    }

    if (declaration.heritageClauses) {
      declaration.heritageClauses.forEach(function(heritage) {

        if (heritage.token == ts.SyntaxKind.ExtendsKeyword) {
          heritageString += " extends";
          heritage.types.forEach(function(typ, idx) {
            heritageString += (idx > 0 ? ',' : '') + typ.getFullText();
          });
        }

        if (heritage.token == ts.SyntaxKind.ImplementsKeyword) {
          heritageString += " implements";
          heritage.types.forEach(function(typ, idx) {
            heritageString += (idx > 0 ? ', ' : '') + typ.getFullText();
          });
        }
      });
    }

    //Make sure duplicate aliases aren't created, so "Ambiguous link" warnings are prevented
    var aliasNames = [name, moduleDoc.id + '/' + name];
    if (typeParamString) {
      aliasNames.push(name + typeParamString);
      aliasNames.push(moduleDoc.id + '/' + name + typeParamString);
    }

    var exportDoc = {
      docType: getExportDocType(exportSymbol),
      accessibility: getExportAccessibility(declaration),
      exportSymbol: exportSymbol,
      name: name,
      id: moduleDoc.id + '/' + name,
      typeParams: typeParamString,
      heritage: heritageString,
      decorators: getDecorators(declaration),
      aliases: aliasNames,
      moduleDoc: moduleDoc,
      content: getContent(declaration),
      fileInfo: getFileInfo(exportSymbol, basePath),
      location: getLocation(declaration),
      additionalDeclarations: additionalDeclarations
    };

    if (exportDoc.docType === 'var' || exportDoc.docType === 'const' || exportDoc.docType === 'let') {
      exportDoc.symbolTypeName = declaration.type &&
                                 declaration.type.typeName &&
                                 declaration.type.typeName.text;
    }

    if (exportDoc.docType === 'type-alias') {
      exportDoc.returnType = getReturnType(typeChecker, declaration);
    }

    if(exportSymbol.flags & ts.SymbolFlags.Function) {
      exportDoc.parameters = getParameters(typeChecker, declaration);
    }
    if(exportSymbol.flags & ts.SymbolFlags.Value) {
      exportDoc.returnType = getReturnType(typeChecker, declaration);
    }
    if (exportSymbol.flags & ts.SymbolFlags.TypeAlias) {
      exportDoc.typeDefinition = typeDefinition;
    }

    // Compute the original module name from the relative file path
    exportDoc.originalModule = exportDoc.fileInfo.projectRelativePath
        .replace(new RegExp('\.' + exportDoc.fileInfo.extension + '$'), '');

    return exportDoc;
  }

  function createMemberDoc(memberSymbol, classDoc, basePath, typeChecker) {
    var declaration = memberSymbol.valueDeclaration || memberSymbol.declarations[0];
    var memberDoc = {
      docType: 'member',
      classDoc: classDoc,
      name: memberSymbol.name,
      accessibility: getExportAccessibility(declaration),
      decorators: getDecorators(declaration),
      content: getContent(declaration),
      fileInfo: getFileInfo(memberSymbol, basePath),
      location: getLocation(declaration)
    };

    memberDoc.typeParameters = getTypeParameters(typeChecker, memberSymbol);

    if(memberSymbol.flags & (ts.SymbolFlags.Signature) ) {
      memberDoc.parameters = getParameters(typeChecker, declaration);
      memberDoc.returnType = getReturnType(typeChecker, declaration);
      switch(memberDoc.name) {
        case '__call':
          memberDoc.name = '';
          break;
        case '__new':
          memberDoc.name = 'new';
          break;
      }
    }

    if (memberSymbol.flags & ts.SymbolFlags.Method) {
      // NOTE: we use the property name `parameters` here so we don't conflict
      // with the `params` property that will be updated by dgeni reading the
      // `@param` tags from the docs
      memberDoc.parameters = getParameters(typeChecker, declaration);
    }

    if (memberSymbol.flags & ts.SymbolFlags.Constructor) {
      memberDoc.parameters = getParameters(typeChecker, declaration);
      memberDoc.name = 'constructor';
    }

    if(memberSymbol.flags & ts.SymbolFlags.Value) {
      memberDoc.returnType = getReturnType(typeChecker, declaration);
    }

    if(memberSymbol.flags & ts.SymbolFlags.Optional) {
      memberDoc.optional = true;
    }

    return memberDoc;
  }


  function getDecorators(declaration) {

    var sourceFile = ts.getSourceFileOfNode(declaration);

    var decorators = declaration.decorators && declaration.decorators.map(function(decorator) {
      decorator = decorator.expression;
      return {
        name: decorator.expression ? decorator.expression.text : decorator.text,
        arguments: decorator.arguments && decorator.arguments.map(function(argument) {
          return getText(sourceFile, argument).trim();
        }),
        argumentInfo: decorator.arguments && decorator.arguments.map(function(argument) {
          return parseArgument(argument);
        }),
        expression: decorator
      };
    });
    return decorators;
  }

  function parseProperties(properties) {
    var result = {};
    _.forEach(properties, function(property) {
      result[property.name.text] = parseArgument(property.initializer);
    });
    return result;
  }

  function parseArgument(argument) {
    if (argument.text) return argument.text;
    if (argument.properties) return parseProperties(argument.properties);
    if (argument.elements) return argument.elements.map(function(element) { return element.text; });
    var sourceFile = ts.getSourceFileOfNode(argument);
    var text = getText(sourceFile, argument).trim();
    return text;
  }

  function getParameters(typeChecker, declaration) {
    var sourceFile = ts.getSourceFileOfNode(declaration);
    if (!declaration.parameters) {
      var location = getLocation(declaration);
      throw new Error('missing declaration parameters for "' + declaration.symbol.name +
        '" in ' + sourceFile.fileName +
        ' at line ' + location.start.line);
    }
    return declaration.parameters.map(function(parameter) {
      var paramText = '';
      if (parameter.dotDotDotToken) {
        paramText += '...';
      }
      paramText += getText(sourceFile, parameter.name);
      if (parameter.questionToken || parameter.initializer) {
        paramText += '?';
      }
      if (parameter.type) {
        paramText += ':' + getType(sourceFile, parameter.type);
      } else {
        paramText += ': any';
        if (parameter.dotDotDotToken) {
          paramText += '[]';
        }
      }
      return paramText.trim();
    });
  }

  function getTypeParameters(typeChecker, symbol) {
    var declaration = symbol.valueDeclaration || symbol.declarations[0];
    var sourceFile = ts.getSourceFileOfNode(declaration);
    if (!declaration.typeParameters) return;
    var typeParams = declaration.typeParameters.map(function(type) {
      return getText(sourceFile, type).trim();
    });
    return typeParams;
  }

  function getReturnType(typeChecker, declaration) {
    var sourceFile = ts.getSourceFileOfNode(declaration);
    if (declaration.type) {
      return getType(sourceFile, declaration.type).trim();
    } else if (declaration.initializer) {
      // The symbol does not have a "type" but it is being initialized
      // so we can deduce the type of from the initializer (mostly).
      if (declaration.initializer.expression) {
        var initializerExpressionText = declaration.initializer.expression.text;
        var intrinsicNameFromTypeChecker = typeChecker.getTypeOfSymbolAtLocation(declaration.symbol, sourceFile).intrinsicName;
        // we might not have an expression text.
        if (initializerExpressionText) {
          return initializerExpressionText.replace(/\s+/g, ' ').trim();
        } else if (intrinsicNameFromTypeChecker) {
          return intrinsicNameFromTypeChecker.trim();
        }
      }
      return getType(sourceFile, declaration.initializer).trim();
    }
  }


  function expandSourceFiles(sourceFiles, basePath) {
    var filePaths = [];
    sourceFiles.forEach(function(sourcePattern) {
      if (sourcePattern.include) {
        var include = glob.sync(sourcePattern.include, {cwd: basePath});
        var exclude = [];
        if (sourcePattern.exclude) {
          exclude = glob.sync(sourcePattern.exclude, {cwd: basePath});
        }
        filePaths = filePaths.concat(_.difference(include, exclude));
      } else {
        filePaths = filePaths.concat(glob.sync(sourcePattern, {cwd: basePath}));
      }
    });
    return filePaths;
  }


  function getText(sourceFile, node) {
    return sourceFile.text.substring(node.pos, node.end);
  }


  function getType(sourceFile, type) {
    var text = getText(sourceFile, type);

    if (type.kind === ts.SyntaxKind.FunctionType) {
      // the type is a function, so we don't do any further processing
      return text;
    }

    // Strip any local renamed imports from the front of types
    // This approach is a bit naive and doesn't account for more complex types
    while (text.indexOf(".") >= 0) {
      // Keep some namespaced symbols
      if (_.some(ignoreTypeScriptNamespaces, function(regex) { return text.match(regex); })) break;
      // handle the case List<thing.stuff> -> List<stuff>
      text = text.replace(/([^.<]*)\.([^>]*)/, "$2");
    }
    return text;
  }

  function getLocation(declaration) {
    var sourceFile = ts.getSourceFileOfNode(declaration);
    var location = {
      start: ts.getLineAndCharacterOfPosition(sourceFile, declaration.pos),
      end: ts.getLineAndCharacterOfPosition(sourceFile, declaration.end)
    };
    return location;
  }

};

function convertToRegexCollection(items) {
  if (!items) return [];

  // Must be an array
  if (!_.isArray(items)) {
    items = [items];
  }

  // Convert string to exact matching regexes
  return items.map(function(item) {
    return _.isString(item) ? new RegExp('^' + item + '$') : item;
  });
}

function anyMatches(regexes, item) {
  for(var i=0; i<regexes.length; ++i) {
    if ( item.match(regexes[i]) ) return true;
  }
  return false;
}
