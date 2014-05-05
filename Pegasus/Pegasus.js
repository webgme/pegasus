/*
 * Copyright (C) 2013 Vanderbilt University, All rights reserved.
 *
 * Author: Brian Broll
 */

define(['plugin/PluginConfig',
        'plugin/PluginBase',
        'util/assert',
        'util/guid'],function(PluginConfig,
                              PluginBase,
                              assert,
                              genGuid){

    var PegasusPlugin = function () {
        // Call base class's constructor
        PluginBase.call(this);
    };

    //basic functions and setting for plugin inheritance
    PegasusPlugin.prototype = Object.create(PluginBase.prototype);
    PegasusPlugin.prototype.constructor = PegasusPlugin;
    PegasusPlugin.prototype.getName = function () {
        return "Pegasus Plugin";
    };

    //config options
    PegasusPlugin.prototype.getConfigStructure = function () {
        return [
            {
                "name": "preview",
                "displayName": "Generate Preview",
                "description": '',
                "value": false, // this is the 'default config'
                "valueType": "boolean",
                "readOnly": false
            },
            {
                "name": "configuration",
                "displayName": "Generate Configuration File",
                "description": '',
                "value": true, // this is the 'default config'
                "valueType": "boolean",
                "readOnly": false
            }
        ]
    };

            //helper functions created by Tamas ;)
    PegasusPlugin.prototype._loadStartingNodes = function(callback){
        //we load the children of the active node
        var self = this;
        self._nodeCache = {};
        self.dx = 60;
        self.dy = 0;
        var load = function(node, fn){
            self.core.loadChildren(node,function(err,children){
                if(err){
                    fn(err)
                } else {
                    var j = children.length,
                        e = null; //error

                    if(j === 0){
                        fn(null);
                    }

                    for(var i=0;i<children.length;i++){
                        self._nodeCache[self.core.getPath(children[i])] = children[i];
                        load(children[i], function(err){
                            e = e || err;
                            if(--j === 0){//callback only on last child
                                fn(e);
                            }
                        });
                    }
                }
            });
        };

        load(self.activeNode, callback);

    };
    PegasusPlugin.prototype._isTypeOf = function(node,type){
        //now we make the check based upon path
        if(node === undefined || node === null || type === undefined || type === null){
            return false;
        }

        var self = this;
        if(self.graph[node] && self.graph[node].baseId){//If given guid
            node = self.graph[node].baseId;
        }

        while(node){
            if(self.core.getPath(node) === self.core.getPath(type)){
                return true;
            }
            node = self.core.getBase(node);
        }
        return false;
    };
    PegasusPlugin.prototype.getNode = function(nodePath){
        //we check only our node cache
        return this._nodeCache[nodePath];
    };

    //the main entry point of plugin execution
    PegasusPlugin.prototype.main = function (callback) {
        var self = this;
        self.config = self.getCurrentConfig();

        //console.log(config.preview,config.configuration);
        self.logger.info("Running Pegasus Plugin");
        self.graph = {};
        self.guid2path = {};
        self.path2guid = {};

        //If activeNode is null, we won't be able to run 
        if(!self._isTypeOf(self.activeNode, self.META['Macro']))
            self._errorMessages(self.activeNode, "Current project is an invalid type. Please run the plugin on a macro.");

        //setting up cache
        self._loadStartingNodes(function(err){
            if(err){
                //finishing
                self.result.success = false;
                callback(err,self.result);
            } else {
                //executing the plugin
                self.logger.info("Finished loading children");
                var err = self._runSync();
                if(err){
                    self.result.success = false;
                    callback(err,self.result);
                } else {
                    var counter = self.config.preview + self.config.configuration;
                    if(self.config.configuration){
                        self._saveOutput(self.projectName.replace(" ", "_") + ".dax", self.output, function(err){
                            if(err){ 
                                self.result.success = false;
                                callback(err,self.result);
                            } else {
                                if(--counter === 0){
                                    if(callback){
                                        self.result.success = true;
                                        callback(null,self.result);
                                    }
                                }
                            }
                        });
                    }

                    if(self.config.preview){
                        self.save("Pegasus plugin modified project",function(err){
                            if(err){ 
                                self.result.success = false;
                                callback(err,self.result);
                            } else {
                                if(--counter === 0){
                                    if(callback){
                                        self.result.success = true;
                                        callback(null,self.result);
                                    }
                                }
                            }
                        });
                    }
                }
            }
        });
    };

    PegasusPlugin.prototype._runSync = function(){
        var self = this;

        self.projectName = self.core.getAttribute(self.activeNode,'name');
        var childrenIds = self._getChildrenAndClearPreview();//delete previously generated preview

        //Create Graph
        self._createGraph(childrenIds);

        if(self.config.preview){
            if(Object.keys(self.graph).length > 250){
                self.createMessage(null, "Preview is too large to display(" + Object.keys(self.graph).length + "). Please use the preview for generating previews of the final structure.");
            }else{
                self._createPreview();
            }
        }

        if(self.config.configuration){
            //Creating the DAX File
            self.output = self._createDAXFile();

        }

        return null;
    };

    //transformed
    PegasusPlugin.prototype._getChildrenAndClearPreview = function(){
        //This method gets the children ids and removes the preview nodes before returning it
        var self = this,
            childrenPaths = self.core.getChildrenPaths(self.activeNode),
            i;

        for(i=0;i<childrenPaths.length;i++){
            if(self._isTypeOf(self._nodeCache[childrenPaths[i]],self.META['InPreviewAspect'])){
                self.core.deleteNode(self._nodeCache[childrenPaths[i]]);
                delete self._nodeCache[childrenPaths[i]];
            }
        }
        childrenPaths = self.core.getChildrenPaths(self.activeNode);

        return childrenPaths;
    };
    //transformed
    PegasusPlugin.prototype._createGraph = function(nIds){
        // I will create a dictionary of objects with pointers to the base/children
        // in the graph
        var self = this,
            n,
            src,s,//src is id, s is node 
            dst,d,//dst is id, d is node 
            nodes,
            srcGuid,
            dstGuid,
            guid,
            i;
        self.graph = {'start': []};

        //Create graph of nodes in workflow aspect
        while(nIds.length){
            //Create entries in the graph for all non-connection ids
            n = self._nodeCache[nIds[0]];
            if(!self._isTypeOf(n,self.META['Connection'])){

                guid = self.core.getGuid(n);
                if(!self.graph[guid]){
                    self.guid2path[guid] = nIds[0];
                    self.path2guid[nIds[0]] = guid;
                    self.graph[guid] = {'base': [], 'child': [], 
                        'params': {
                            'atr': JSON.parse(JSON.stringify(n.data.atr)), 
                            'reg': JSON.parse(JSON.stringify(n.data.reg))
                        },
                        'baseId': self.core.getBase(n) };
                }

                //If it has a different aspect position
                if(self.core.getMemberRegistry(self.activeNode, "Workspace", nIds[0], 'position') ){
                    self.graph[guid].params.reg.position = JSON.parse(JSON.stringify(
                                self.core.getMemberRegistry(self.activeNode, "Workspace", nIds[0], 'position') ));
                }

                if(self._isTypeOf(guid, self.META["Job"])){
                    self.graph[guid].params.atr.cmd = self.core.getAttribute(n, 'cmd');//Force cmd attribute
                }

            }else {//Connection
                src = self.core.getPointerPath(n,'src');
                dst = self.core.getPointerPath(n,'dst');
                s = self.getNode(src);
                d = self.getNode(dst);
                srcGuid = self.core.getGuid(s);
                dstGuid = self.core.getGuid(d);

                //Create src/dst if necessary
                if(!self.graph[srcGuid]){

                    self.guid2path[srcGuid] = src;
                    self.graph[srcGuid] = {'base': [], 'child': [], 
                        'params': {
                            'atr': JSON.parse(JSON.stringify(s.data.atr)), 
                            'reg': JSON.parse(JSON.stringify(s.data.reg))
                        },
                        'baseId': self.core.getBase(s) };

                    //If it has a different aspect position
                    if(self.core.getMemberRegistry(self.activeNode, "Workspace", src, 'position') ){
                        self.graph[srcGuid].params.reg.position = JSON.parse(JSON.stringify(
                                    self.core.getMemberRegistry(self.activeNode, "Workspace", src, 'position') ));
                    }
                }

                if(!self.graph[dstGuid]){
                    self.guid2path[dstGuid] = dst;
                    self.graph[dstGuid] = {'base': [], 'child': [],
                        'params': {
                            'atr': JSON.parse(JSON.stringify(d.data.atr)), 
                            'reg': JSON.parse(JSON.stringify(d.data.reg))
                        },
                        'baseId': self.core.getBase(d) };

                    //If it has a different aspect position
                    if(self.core.getMemberRegistry(self.activeNode, "Workspace", dst, 'position') ){
                        self.graph[dstGuid].params.reg.position = JSON.parse(JSON.stringify(
                                    self.core.getMemberRegistry(self.activeNode, "Workspace", dst, 'position') ));
                    }
                }

                //Update the src/dst entries in the graph
                self.graph[srcGuid].child.push(dstGuid);
                self.graph[dstGuid].base.push(srcGuid);
            }

            nIds.splice(0,1);
        }

        //Store the start node as 'start' in the dictionary
        nodes = Object.keys(self.graph);
        for(i=0;i<nodes.length;i++){
            if(nodes[i] !== 'start'){
                n = nodes[i];
                if(self._isTypeOf(n,self.META['FileSet']) || self._isTypeOf(n,self.META['File'])){
                    if(self.graph[nodes[i]].base.length === 0){
                        self.graph['start'].push(nodes[i]);
                    }
                }
            }
        }

        //Create the resulting workflow
        self._expandGraph();
    };

    PegasusPlugin.prototype._expandGraph = function(){
        //Expand self.graph to the whole workflow
        var self = this,
            forks;//Create lists out of lists

        forks = self._resolveFileSetsAndGetForks();
        if(forks.length){
            self._expandForks(forks);
        }

    };
    //transformed
    PegasusPlugin.prototype._createPreview = function(){
        var self = this,
            nodeIds = self.graph['start'],
            visited = {},//dictionary of visited nodes
            j;

        while(nodeIds.length){
            if(visited[nodeIds[0]]){
                nodeIds.splice(0,1);
                continue;
            }
            //Create nodeIds[0] preview item
            self.guid2path[nodeIds[0]] = self._createPreviewNode(nodeIds[0]);

            j = self.graph[nodeIds[0]].base.length;

            while(j--){
                self._createConnection(this.graph[nodeIds[0]].base[j], nodeIds[0]);
            }

            nodeIds = nodeIds.concat(this.graph[nodeIds[0]].child);
            visited[nodeIds.splice(0,1)[0]] = true;
        }
    };
    //transformed
    PegasusPlugin.prototype._resolveFileSetsAndGetForks = function(){
        // Traverse/Update the graph and create the forks object
        var self = this,
            forks = [],
            nodeIds = self.graph.start.slice(),
            visited = {},
            preview,
            currFork,//Preview node
            fork,
            forkId,
            mergeId,
            path,
            fsId,
            ids,
            skip,
            del,
            last,
            j,
            i;

        while(nodeIds.length) {//BFS
            skip = false;
            del = false;
            preview = null;

            if(visited[nodeIds[0]]){
                nodeIds.splice(0,1);
                continue;
            }
            visited[nodeIds[0]] = true;

            //If the next node is a fork
            //Create a fork object and add to "forks"
            if( self._isTypeOf(self.graph[nodeIds[0]].child[0],self.META['Fork']) ) {
                fork = { 'start': nodeIds[0], 'in': [], 'out': null  };
                if(currFork){//set the 'in'/'out' variable
                    currFork.in.push(fork);
                    fork.out = currFork;
                }else{
                    forks.push(fork);
                }

                currFork = fork;

                //Remove Fork object from graph
                forkId = self.graph[nodeIds[0]].child[0];
                self._removeFromGraph(forkId);
                skip = true;

            } else if( self._isTypeOf(nodeIds[0],self.META['Merge']) ) { //If merge operator

                //Close the current fork
                mergeId = nodeIds[0];
                assert(currFork, "No current fork");
                currFork.end = self.graph[mergeId].base;

                assert(self.graph[mergeId].child.length === 1, "Merge operators can have only one node following");
                fsId = self.graph[mergeId].child[0];

                currFork = currFork.out;

                assert(self.graph[mergeId].child.length === 1, "Merge operator can only have one connection out");
                assert(self._isTypeOf(self.graph[nodeIds[0]].child[0],self.META['FileSet']), "FileSet must follow a Merge operator");

                //Remove Merge object from graph
                nodeIds[0] = self.graph[mergeId].base[0];
                self._removeFromGraph(fsId);
                self._removeFromGraph(mergeId);

            } else if( self._isTypeOf(nodeIds[0],self.META['FileSet']) ) {//If the node is a fileset and next is not a fork
                self._processFileSet(nodeIds[0]);             //Resolve the whole fileset and insert the additional files into the graph
            }

            if(skip){
                nodeIds = nodeIds.concat(self.graph[self.graph[nodeIds[0]].child].child);
            }else{
                nodeIds = nodeIds.concat(self.graph[nodeIds[0]].child);
            }

            last = nodeIds[nodeIds.length-1];
            nodeIds.splice(0,1);
        }

        //If currently in a fork, close it
        //Close the current fork
        while(currFork){
            currFork.end = last;
            currFork = currFork.out;
        };

        return forks;
    };
    //transformed
    PegasusPlugin.prototype._expandForks = function(forks){
        for(var i = 0; i < forks.length; i++){//This list is the outermost forks
            this._copyFork(forks[i]);
        }
    };
    //transformed
    PegasusPlugin.prototype._copyFork = function(fork){
        var self = this,
            i = fork.in.length,
            numCopies,
            copyRequest = {},//{'parentId': self.activeNode},
            nodes = [],
            x1,
            x2,
            y1,
            y2,
            j;

        assert(fork.start && fork.end, "Fork missing a merge operator");
        assert(self._isTypeOf(fork.start, self.META["FileSet"]), "Fork must start with a fileset");

        //Copy any inside forks
        while(i--){
            self._copyFork(fork.in[i]);
        }

        //Resolve the first and last file
        var fileObject = self._createFileFromFileSet(self.guid2path[fork.start]),
            sfile = fileObject.id;//start file

        startNames = fileObject.names;

        //Insert the first file into the graph
        self.graph[sfile] = { 'base': self.graph[fork.start].base, 
            'child': self.graph[fork.start].child, 'baseId': fileObject.baseId,
            'params': fileObject.params };

        self._replaceInGraph(sfile, self.graph[sfile], fork.start);


        fork.start = sfile;

        //Get the number of copies needed from fork.start fileset
        numCopies = startNames.length;

        nodes.push(sfile);

        //Figure out the size of the current fork
        var pos,
            nodeIds = [],
            visited = {};

        while(self.graph[nodes[0]] && self.graph[nodes[0]].base.indexOf(fork.end[0]) === -1){
            //BFS
            if(nodeIds.indexOf(nodes[0]) !== -1){
                nodes.splice(0,1);
                continue;
            }
            nodeIds.push(nodes[0]);//Create list of nodes to copy

            //Get the position info about entire box
            pos = self.graph[nodes[0]].params.reg.position;
            x1 = Math.min(x1, pos.x) || pos.x;
            x2 = Math.max(x2, pos.x) || pos.x;
            y1 = Math.min(y1, pos.y) || pos.y;
            y2 = Math.max(y2, pos.y) || pos.y;

            //Add next nodes
            nodes = nodes.concat(self.graph[nodes[0]].child);

            nodes.splice(0,1);
        }

        //Copy the nodes
        var dx = self.dx + (x2-x1),
            dy = self.dy + (y2-y1),
            copiedPaths,
            params,
            base,
            child,
            x = {},
            y = {},
            copyPaths = Object.keys(copyRequest),
            guid,
            old2new = {},
            node,
            k;

        for(i = 1; i < numCopies; i++){
            //Generate guid's for each element of nodeIds
            old2new = {};
            for(k = 0; k < nodeIds.length; k++){//Generate guids
                old2new[nodeIds[k]] = genGuid();

                if(self.graph.start.indexOf(nodeIds[k]) !== -1){//Add guid to start if necessary
                    self.graph.start.push(old2new[nodeIds[k]]);
                }
            }

            for(k = 0; k < nodeIds.length; k++){

                guid = old2new[nodeIds[k]];

                //Adjust the position and name attributes
                params = JSON.parse(JSON.stringify(self.graph[nodeIds[k]].params));
                params.reg.position.x += dx;
                //params.reg.position.y += dy;

                if(k === 0){
                    params.atr.name = fileObject.names[i];
                }else if(self._isTypeOf(nodeIds[k], self.META["File"])){
                    if(i === 1){
                        params.atr.name += "(2)";
                    }else{
                        params.atr.name = params.atr.name.substring(0, params.atr.name.lastIndexOf("(")) + "(" + (i+1) + ")";
                    }
                }
                //Add the node to the graph
                self.graph[guid] = { base: self.graph[nodeIds[k]].base.slice(),
                                     child: self.graph[nodeIds[k]].child.slice(),
                                     baseId: self.graph[nodeIds[k]].baseId,
                                     params: params };

                j = self.graph[guid].base.length;
                while(j--){
                    base = self.graph[guid].base[j];

                    if(old2new[base]){//Connecting to node inside the graph
                        self.graph[guid].base[j] = old2new[base];
                    }else{
                        self.graph[base].child.push(guid);
                    }
                }

                j = self.graph[guid].child.length;
                while(j--){
                    child = self.graph[guid].child[j];

                    if(old2new[child]){//Connecting to node inside the graph
                        self.graph[guid].child[j] = old2new[child];
                    }else{
                        self.graph[child].base.push(guid);
                    }
                }
                //Replace the id of nodeId[k] to the new id
                nodeIds[k] = guid;
            }
        }

    };
    //transformed
    PegasusPlugin.prototype._replaceInGraph = function(guid, node, original){
        var self = this,
            j = self.graph.start.indexOf(original);

        self._addToGraph(guid, node, original);

        if(j !== -1)
            self.graph.start.splice(j,1);

        i = self.graph[original].base.length;//Set all bases' children ptrs
        while(i--){

            j = self.graph[self.graph[original].base[i]].child.indexOf(original);
            if(j !== -1){
                self.graph[self.graph[original].base[i]].child.splice(j, 1); //replace original with node
            }
        }

        i = self.graph[original].child.length;
        while(i--){//Remove from all children's base ptrs

            j = self.graph[self.graph[original].child[i]].base.indexOf(original);
            if(j !== -1){
                self.graph[self.graph[original].child[i]].base.splice(j, 1); //replace original with node
            }
        }

        delete self.graph[original];
    };
    //transformed
    PegasusPlugin.prototype._addToGraph = function(guid, node, original){
        var self = this,
            isStart = self.graph.start.indexOf(original) > -1,
            j,
            i;

        if(isStart)
            self.graph.start.push(guid);

        //Set the node's child/base ptrs
        self.graph[guid] = node;
        self.graph[guid].base = self.graph[original].base;
        self.graph[guid].child = self.graph[original].child;

        i = self.graph[original].base.length;//Set all bases' children ptrs
        while(i--){
            if(self.graph[self.graph[original].base[i]].child.indexOf(guid) !== -1)//Kinda hacky
                continue;

            self.graph[self.graph[original].base[i]].child.push(guid);
        }

        i = self.graph[original].child.length;
        while(i--){//Set all children's base ptrs
            if(self.graph[self.graph[original].child[i]].base.indexOf(guid) !== -1)
                continue;

            self.graph[self.graph[original].child[i]].base.push(guid); 
        }
    };
    //transformed
    PegasusPlugin.prototype._removeFromGraph = function(node){
        //Remove node from graph and splice the base to point to children
        assert(this.graph[node], "Can't remove non-existent node from graph!");

        var self = this,
            children = self.graph[node].child,
            bases = self.graph[node].base,
            i = children.length,
            j,
            k;

        //Connect children to base
        while(i--){
            j = bases.length;
            k = self.graph[children[i]].base.indexOf(node);
            if(k !== -1)
                self.graph[children[i]].base.splice(k, 1);

            while(j--){
                if(self.graph[children[i]].base.indexOf(bases[j]) === -1){
                    self.graph[children[i]].base.push(bases[j]);
                }
            }
        }

        //Connect base to children
        i = bases.length;
        while(i--){
            j = children.length;
            k = self.graph[bases[i]].child.indexOf(node);

            if(k !== -1)
                self.graph[bases[i]].child.splice(k, 1);
            while(j--){
                if(self.graph[bases[i]].child.indexOf(children[j]) === -1){
                    self.graph[bases[i]].child.push(children[j]);
                }
            }
        }

        delete self.graph[node];
    };
    //transformed
    PegasusPlugin.prototype._processFileSet = function(fsId){//return ids: [ first file, ... rest ]
        var self = this,
            fsPath = this.guid2path[fsId],
            fileObject = self._createFileFromFileSet(fsPath),
            baseId = fileObject.baseId,
            id,
            names = fileObject.names,
            pos = { 'x': fileObject.position.x, 'y': fileObject.position.y },
            dx = self.dx,
            dy = self.dy,
            i,
            params,
            position,
            j;

        i = -1;
        //Next, we will create the rest of the files
        while(++i < names.length){
            //Create params
            params = JSON.parse(JSON.stringify(fileObject.params));
            params.reg.position = { 'x': pos.x+(i)*dx, 'y': pos.y+(i)*dy };
            params.atr.name = names[i];

            id = genGuid();
            self.graph[id] = { 'base': self.graph[fsId].base, 'child': self.graph[fsId].child, 
                'baseId': baseId, 'params': params };//Add the files to the graph

            j = self.graph[fsId].base.length;
            while(j--){
                self.graph[self.graph[fsId].base[j]].child.push(id);
            }

            j = self.graph[fsId].child.length;
            while(j--){
                self.graph[this.graph[fsId].child[j]].base.push(id);
            }
        }

        //Remove fsId from graph
        self._removeFromGraph(fsId);
    };
    //transformed
    PegasusPlugin.prototype._createFileFromFileSet = function(fsPath, doNotMove){//If doNotMove is true, it won't be moved
        var self = this,
            pos = JSON.parse(JSON.stringify(self.core.getMemberRegistry(self.activeNode, "Workspace", fsPath, 'position') 
                        || self.core.getRegistry(self._nodeCache[fsPath],'position'))),
            names = self._getFileNames(fsPath),
            guid = genGuid(),
            node = self.getNode(fsPath),
            atr = JSON.parse(JSON.stringify(node.data.atr)),
            reg = JSON.parse(JSON.stringify(node.data.reg));

        atr.name = names[0];
        //Return file to add to the graph
       
        return { 'id': guid, 'baseId': self.META['File'], 
            'params': { 'atr': atr, 'reg': reg }, 'names': names, 'position': pos };
    };
    //transformed
    PegasusPlugin.prototype._createConnection = function(srcGuid, dstGuid){
        var self = this,
            src = self.guid2path[srcGuid],
            dst = self.guid2path[dstGuid],
            newConnection = self.core.createNode({parent:self.activeNode,base:self.META['PreviewConn']});

        self.core.setPointer(newConnection,'src',self._nodeCache[src]);
        self.core.setPointer(newConnection,'dst',self._nodeCache[dst]);

        self._nodeCache[self.core.getPath(newConnection)] = newConnection;
        return self.core.getPath(newConnection);
    };
    //transformed
    PegasusPlugin.prototype._createPreviewNode = function(guid){
        var self = this,
            path,
            baseId = self.META["PreviewJob"],
            preview;

        //Get correct baseId
        if(self._isTypeOf(guid, self.META["File"])){//Create PreviewFile
            baseId = self.META["PreviewFile"];
        }

        preview = self.core.createNode({parent:self.activeNode, base:baseId });

        //Create node using baseId
        for(var a in self.graph[guid].params.atr){
            if(self.graph[guid].params.atr.hasOwnProperty(a)){
                self.core.setAttribute(preview,a,self.graph[guid].params.atr[a]);
            }
        }

        for(var a in self.graph[guid].params.reg){
            if(self.graph[guid].params.reg.hasOwnProperty(a)){
                self.core.setRegistry(preview,a,self.graph[guid].params.reg[a]);
            }
        }

        //Add it to nodeCache 
        path = self.core.getPath(preview);
        self._nodeCache[path] = preview;

        return path;
    };

    //transformed
    PegasusPlugin.prototype._getFileNames = function(fsId){//FileSet node
        var self = this,
            fs = self._nodeCache[fsId],
            filenames = self.core.getAttribute(fs,'filenames'),
            names = [],
            k = filenames.indexOf('['),
            basename = filenames.slice(0,k) + "%COUNT" + filenames.slice(filenames.lastIndexOf(']')+1),
            i = filenames.slice(k+1),
            j;//Only supports one set of numbered input for now

        j = parseInt(i.slice(i.indexOf('-')+1, i.indexOf(']')));
        i = parseInt(i.slice(0,i.indexOf('-')));

        k = Math.max(i,j);
        i = Math.min(i,j)-1;

        if(isNaN(i+j)) {
            names = [filenames];
        }

        while(i++ < j) {
            names.push(basename.replace("%COUNT", i));
        }

        return names;
    };

    PegasusPlugin.prototype._createDAXFile = function(){
        //Create DAX file for Pegasus
        var self = this,
            nodes = self.graph.start.slice(),
            jobs = [],
            dax = '<?xml version="1.0" encoding="UTF-8"?>\n'+
            //'<!-- generated on ' + (new Date()).toDateString() + " -->\n' +
            '<!-- generated with WebGME -->\n' + 
            '<adag xmlns="http://pegasus.isi.edu/schema/DAX" ' + 
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' + 
            'xsi:schemaLocation="http://pegasus.isi.edu/schema/DAX ' +
            'http://pegasus.isi.edu/schema/dax-3.4.xsd" version="3.4" ' +
            'name="' + self.projectName +'">\n',
            childInfo = "",
            visited = {},
            i;

        self.guid2id = {};//Dictionary of guid -> id's for config

        //Traverse the graph and create job info
        while(nodes.length){

            if(visited[nodes[0]]){
                nodes.splice(0,1);
                continue;
            }
            visited[nodes[0]] = true;

            if(self._isTypeOf(nodes[0],self.META['Job'])){
                jobs.push(nodes[0]);
            }

            nodes = nodes.concat(self.graph[nodes[0]].child);
            nodes.splice(0,1);
        }

        i = jobs.length;
        while(i--){
            id = i.toString();
            while(id.length < 6){
                id = "0" + id;
            }
            id = "ID" + id;
            self.guid2id[jobs[i]] = id;
        }

        i = jobs.length;
        while(i--){
            dax += self._createJobConfig(jobs[i]);//Create Job Section
            childInfo += self._createChildInfo(jobs[i]);//Create Parent-Child Stuff
        }

        dax += childInfo + '</adag>';
        return dax;
    };

    PegasusPlugin.prototype._createJobConfig = function(job, id){
        var self = this, 
            id = self.guid2id[job],
            params = self.graph[job].params,
            name = params.atr.name || self.core.getAttribute(self.META['Job'], 'name'),
            cmd = params.atr.cmd || self.core.getAttribute(self.META['Job'], 'cmd'),
            args = cmd.substring(cmd.indexOf(" ")+1),
            input = [],
            output = [],
            result = '\t<job id="' + id + '" name="' + name + '" >\n',
            i = self.graph[job].base.length,
            j = args.indexOf('$in '),
            k = args.indexOf(' $out'),
            id,
            n;

        result += '\t\t<argument>' + args.substring(0, j);

        //Get files coming in and create argument
        while(i--){
            id = self.graph[job].base[i];
            n = self.graph[id].params.atr.name;
            input.push(n);
            result += '<file name="' + n + '"/> ';
        }

        result += args.substring(j+4, k);
        //Get files going out
        i = self.graph[job].child.length;
        while(i--){
            id = self.graph[job].child[i];
            n = self.graph[id].params.atr.name;
            output.push(n);
            result += ' <file name="' + n + '"/> ';
        }
        result += args.substring(k+5) + '</argument>\n';

        i = input.length;
        while(i--){
            result += '\t\t<uses name="' + input[i] + '" link="input"/>\n';
        }

        i = output.length;
        while(i--){
            result += '\t\t<uses name="' + output[i] + '" link="output"/>\n';
        }

        result += "\t</job>\n";

        return result;
    };

    PegasusPlugin.prototype._createChildInfo = function(job){
        var self = this, 
            id = self.guid2id[job],
            parents = [],
            result = '\t<child ref="' + id + '">\n',
            i = self.graph[job].base.length,
            node,
            inFile;

        while(i--){
            inFile = self.graph[job].base[i];
            parents = parents.concat(self.graph[inFile].base);
        }

        if(parents.length === 0)
            return "";

        i = parents.length;
        while(i--){
            id = self.guid2id[parents[i]];
            result += '\t\t<parent ref="' + id + '" />\n';
        } 

        result += '\t</child>\n';
        return result;
    };

    //Thanks to Tamas for the next function
    PegasusPlugin.prototype._saveOutput = function(fileName,stringFileContent,callback){
        var self = this,
            artifact = self.blobClient.createArtifact(self.projectName.replace(" ", "_")+"_Config");

        artifact.addFile(fileName,stringFileContent,function(err){
            if(err){
                callback(err);
            } else {
                self.blobClient.saveAllArtifacts(function(err, hashes) {
                    if (err) {
                        callback(err);
                    } else {
                        self.logger.info('Artifacts are saved here:');
                        self.logger.info(hashes);

                        // result add hashes
                        for (var j = 0; j < hashes.length; j += 1) {
                            self.result.addArtifact(hashes[j]);
                        }

                        self.result.setSuccess(true);
                        callback(null);
                    }
                });
            }
        });
    };

    return PegasusPlugin;
});
