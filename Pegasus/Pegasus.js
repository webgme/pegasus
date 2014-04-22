define(['plugin/PluginConfig','plugin/PluginBase','util/assert'],function(PluginConfig,PluginBase,assert){

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

    //helper functions created by Tamas ;)
    PegasusPlugin.prototype._loadStartingNodes = function(callback){
        //we load the children of the active node
        var self = this;
        self._nodeCache = {};
        self.dx = 140;
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
        self.logger.info("Running Pegasus Plugin");
        self.original2copy = {}; //Mapping original node ids to copy
        self.graph = null;
        self.params = [{ 'parentId': self.ActiveNode }];
        self.extraCopying = [];

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
                    self.save("Pegasus plugin modified project",function(err){
                        if(callback){
                            self.result.success = true;
                            callback(null,self.result);
                        }
                    });
                }
            }
        });
    };

    PegasusPlugin.prototype._runSync = function(){
        var self = this;

        //Copying project
        self.outputId = self.activeNode;//this._createOutputProject();
        var childrenIds = self._getChildrenAndClearPreview();//delete previously generated preview

        self._createCopyLists(childrenIds);

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
    PegasusPlugin.prototype._createCopyLists = function(nIds){
        var self = this,
            forks;//Create lists out of lists

        //Next, for each path, I will resolve the dot operators then the filesets
        self._createGraph(nIds);
        forks = self._createSkeletonWorkflowAndGetForks();
        if(forks.length){
            self._copyForkGroups(forks);
        }
        self._connectPreviewObjects();
    };
    //transformed
    PegasusPlugin.prototype._createGraph = function(nIds){
        // I will create a dictionary of objects with pointers to the base/children
        // in the graph
        var self = this,
            n,src,dst,nodes,i;
        self.graph = {'start': []};

        //Order the nodes by the following rule:
        //If it is linked to the last node, add it
        //O.W. get the highest node
        while(nIds.length){
            //Create entries in the graph for all non-connection ids
            n = self._nodeCache[nIds[0]];
            if(!self._isTypeOf(n,self.META['Connection'])){

                if(!self.graph[nIds[0]]){
                    self.graph[nIds[0]] = {'base': [], 'child': []};
                }

            }else {//Connection
                src = self.core.getPointerPath(n,'src');
                dst = self.core.getPointerPath(n,'dst');

                //Create src/dst if necessary
                if(!this.graph[src]){
                    this.graph[src] = {'base': [], 'child': []};
                }

                if(!this.graph[dst]){
                    this.graph[dst] = {'base': [], 'child': []};
                }

                //Update the src/dst entries in the graph
                this.graph[src].child.push(dst);
                this.graph[dst].base.push(src);
            }

            nIds.splice(0,1);
        }

        //Store the start node as 'start' in the dictionary
        nodes = Object.keys(self.graph);
        for(i=0;i<nodes.length;i++){
            if(nodes[i] !== 'start'){
                n = self._nodeCache[nodes[i]];
                if(self._isTypeOf(n,self.META['FileSet']) || self._isTypeOf(n,self.META['File'])){
                    if(self.graph[nodes[i]].base.length === 0){
                        self.graph['start'].push(nodes[i]);
                    }
                }
            }
        }
    };
    //transformed
    PegasusPlugin.prototype._createSkeletonWorkflowAndGetForks = function(){
        // Traverse/Update the graph and create the forks object
        var self = this,
            forks = [],
            nodeIds = self.graph.start,
            preview,
            currFork,//Preview node
            fork,
            forkId,
            mergeId,
            fsId,
            ids,
            skip,
            del,
            j,
            i;

        while(nodeIds.length) {//BFS
            skip = false;
            del = false;
            preview = null;
            //If the next node is a fork
            //Create a fork object and add to "forks"
            if( self._isTypeOf(self._nodeCache[self.graph[nodeIds[0]].child[0]],self.META['Fork']) ) {
                fork = { 'start': nodeIds[0], 'in': [], 'out': null  };
                if(currFork){//set the 'in'/'out' variable
                    currFork.in.push(fork);
                    fork.out = currFork;
                }

                forks.push(fork);
                currFork = fork;

                //Remove Fork object from graph
                forkId = this.graph[nodeIds[0]].child[0];
                this.graph[nodeIds[0]].child = this.graph[forkId].child;

                i = this.graph[nodeIds[0]].child.length;
                while(i--){
                    j = this.graph[this.graph[nodeIds[0]].child[i]].base.indexOf(forkId);
                    assert(j !== -1);
                    this.graph[this.graph[nodeIds[0]].child[i]].base.splice(j, 1, nodeIds[0]);
                }

                delete self.graph[forkId];

            } else if( self._isTypeOf(self._nodeCache[nodeIds[0]],self.META['Merge']) ) { //If merge operator

                //Close the current fork
                mergeId = nodeIds[0];
                assert(currFork, "No current fork");
                currFork.end = self.graph[mergeId].base;

                assert(self.graph[mergeId].child.length === 1, "Merge operators can have only one node following");
                fsId = self.graph[mergeId].child[0];

                currFork = currFork.out;

                assert(self.graph[mergeId].child.length === 1, "Merge operator can only have one connection out");
                assert(self._isTypeOf(self._nodeCache[self.graph[nodeIds[0]].child[0]],self.META['FileSet']), "FileSet must follow a Merge operator");

                //Remove Merge object from graph
                nodeIds[0] = self.graph[mergeId].base[0];
                self._removeFromGraph(fsId);
                self._removeFromGraph(mergeId);

            } else if( self._isTypeOf(self._nodeCache[nodeIds[0]],self.META['FileSet']) ) {//If the node is a fileset and next is not a fork
                ids = self._processFileSet(nodeIds[0]);             //Resolve the whole fileset and insert the additional files into the graph
                preview = ids[0];
                i = 0;

                while(++i < ids.length){
                    self.graph[ids[i]] = { 'base': self.graph[nodeIds[0]].base, 'child': self.graph[nodeIds[0]].child };
                }
                //j = nodeIds[0].base.length;
                //while(j--){
                //this._createConnection(nodeIds[0].base[j], ids[i]);//Create connection
                //}
            }else {//Else create preview node

                preview = self._createPreviewNode(nodeIds[0]);
            }

            //Add the children of nodeId to nodeIds
            if(skip){
                nodeIds = nodeIds.concat(self.graph[self.graph[nodeIds[0]].child].child);
            }else{
                nodeIds = nodeIds.concat(self.graph[nodeIds[0]].child);
            }

            //Replace nodeIds[0] with preview object
            if(preview){

                self._replaceInGraph(preview, nodeIds[0]);
            }

            nodeIds.splice(0,1);
        }

        return forks;
    };
    //transformed
    PegasusPlugin.prototype._copyForkGroups = function(forks){
        var outer = forks[0];

        //Find the outermost fork and copy it
        while(outer.out){
            outer = outer.out;
        }

        this._copyFork(outer);
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

        //Copy any inside forks
        while(i--){
            self._copyFork(fork.in[i]);
        }

        //Resolve the first and last file
        var fileObject = self._createFileFromFileSet(fork.start, true),
            sfile = fileObject.id;//start file

        startNames = fileObject.names;

        //Insert the files into the graph
        self._replaceInGraph(sfile, fork.start);

        fork.start = sfile;

        //Get the number of copies needed from fork.start fileset
        numCopies = startNames.length;

        nodes.push(sfile);
        //Figure out the size of the current fork

        var pos;
        while(self.graph[nodes[0]] && self.graph[nodes[0]].base.indexOf(fork.end[0]) === -1){
            //BFS
            //Get the position info about entire box
            pos = self.core.getMemberRegistry(self.activeNode, "Workspace", nodes[0], 'position') || self.core.getRegistry(self._nodeCache[nodes[0]],'position');
            x1 = Math.min(x1, pos.x) || pos.x;
            x2 = Math.max(x2, pos.x) || pos.x;
            y1 = Math.min(y1, pos.y) || pos.y;
            y2 = Math.max(y2, pos.y) || pos.y;


            //copy the node
            //Create list of nodes to copy
            copyRequest[nodes[0]] = { 'registry': { 'position': { 'x': pos.x , 'y': pos.y} }};
            //copyRequest[nodes[0]]['registry'][

            //Add next nodes
            nodes = nodes.concat(self.graph[nodes[0]].child);

            nodes.splice(0,1);
        }

        //Copy the nodes
        var dx = self.dx + (x2-x1),
            dy = self.dy + (y2-y1),
            copiedPaths,
            base,
            child,
            x = {},
            y = {};

        for(var k in copyRequest){
            if(copyRequest.hasOwnProperty(k) && k !== 'parentId'){
                x[k] = copyRequest[k]['registry']['position']['x'];
                y[k] = copyRequest[k]['registry']['position']['y'];
                //copyRequest[k]['registry']['position']['y'] += dy;
            }
        }

        i = 0;
        while(++i < numCopies){
            //Set names
            copyRequest[sfile].attributes = {};
            copyRequest[sfile].attributes.name = startNames[i];

            //Shift each node
            var copyPaths = Object.keys(copyRequest),
                k;

            //repositioning
            for(k=0;k<copyPaths.length;k++){
                copyRequest[copyPaths[k]].registry.position = { 'x': x[copyPaths[k]]+=dx, 'y': y[copyPaths[k]] };
            }

            //do the actual copying - we copy the nodes one-by-one as there is no connection among them!!!
            copiedPaths = [];
            for(k=0;k<copyPaths.length;k++){
                var copiedNode = self.core.copyNode(self._nodeCache[copyPaths[k]],self.activeNode);
                self.core.setRegistry(copiedNode,'position',copyRequest[copyPaths[k]].registry.position);
                if( copyRequest[copyPaths[k]].attributes && copyRequest[copyPaths[k]].attributes.name){
                    self.core.setAttribute(copiedNode,'name',copyRequest[copyPaths[k]].attributes.name);
                }
                self._nodeCache[self.core.getPath(copiedNode)] = copiedNode;
                copiedPaths.push(self.core.getPath(copiedNode));
            }

            //Insert nodes into graph
            for(k=0;k<copiedPaths.length;k++){
                if(self.graph.start.indexOf(copyPaths[k]) !== -1){
                    self.graph.start.push(copiedPaths[k]);
                }

                self.graph[copiedPaths[k]] = { 'base': [], 'child': [] };
                j = self.graph[copyPaths[k]].base.length;
                while(j--){
                    base = self.graph[copyPaths[k]].base[j];

                    if(copyPaths.indexOf(base) !== -1){
                        self.graph[copiedPaths[k]].base.push(copiedPaths[copyPaths.indexOf(base)]);//Set the base of the new point
                    }else{
                        self.graph[copiedPaths[k]].base.push(base);//Set the base of the new point
                        self.graph[base].child.push(copiedPaths[k]);
                    }
                }

                j = this.graph[copyPaths[k]].child.length;
                while(j--){
                    child = self.graph[copyPaths[k]].child[j];

                    if(copyPaths.indexOf(child) !== -1){
                        self.graph[copiedPaths[k]].child.push(copiedPaths[copyPaths.indexOf(child)]);//Set the child of the new point
                    }else{
                        self.graph[copiedPaths[k]].child.push(child);//Set the child of the new point
                        self.graph[child].base.push(copiedPaths[k]);
                    }
                }
            }
        }
    };
    //transformed
    PegasusPlugin.prototype._connectPreviewObjects = function(){
        var self = this,
            nodeIds = this.graph['start'],
            visited = {},//dictionary of visited nodes
            j;

        while(nodeIds.length){
            if(visited[nodeIds[0]]){
                nodeIds.splice(0,1);
                continue;
            }

            j = self.graph[nodeIds[0]].base.length;

            while(j--){
                self._createConnection(this.graph[nodeIds[0]].base[j], nodeIds[0]);
            }

            nodeIds = nodeIds.concat(this.graph[nodeIds[0]].child);
            visited[nodeIds.splice(0,1)[0]] = true;
        }
    };
    //transformed
    PegasusPlugin.prototype._replaceInGraph = function(nodes, original){
        var self = this,
            j = self.graph.start.indexOf(original);
        nodes = nodes instanceof Array ? nodes : [nodes];

        self._addToGraph(nodes, original);

        if(j !== -1)
            self.graph.start.splice(j,1);

        delete self.graph[original];
    };
    //transformed
    PegasusPlugin.prototype._addToGraph = function(nodes, original){
        nodes = nodes instanceof Array ? nodes : [ nodes ];
        var self = this,
            node,
            isStart = self.graph.start.indexOf(original) > -1,
            k = nodes.length,
            j,
            i;

        while(k--){
            node = nodes[k];

            if(isStart)
                self.graph.start.push(node);

            //Set the node's child/base ptrs
            self.graph[node] = this.graph[original];

            i = self.graph[original].base.length;//Set all bases' children ptrs
            while(i--){
                if(self.graph[self.graph[original].base[i]].child.indexOf(node) !== -1)//Kinda hacky
                    continue;

                j = self.graph[self.graph[original].base[i]].child.indexOf(original);
                if(j !== -1){
                    self.graph[self.graph[original].base[i]].child.splice(j, 1, node); //replace original with node
                }else{
                    self.graph[self.graph[original].base[i]].child.push(node); //replace original with node
                }
            }

            i = self.graph[original].child.length;
            while(i--){//Set all children's base ptrs
                if(self.graph[self.graph[original].child[i]].base.indexOf(node) !== -1)
                    continue;

                j = self.graph[self.graph[original].child[i]].base.indexOf(original);
                if(j !== -1){
                    self.graph[self.graph[original].child[i]].base.splice(j, 1, node); //replace original with node
                }else{
                    self.graph[self.graph[original].child[i]].base.push(node); //replace original with node
                }
            }
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
            fileObject = self._createFileFromFileSet(fsId),
            ids = [ fileObject.id ],
            id,
            names = fileObject.names,
            pos = { 'x': fileObject.position.x, 'y': fileObject.position.y },
            dx = self.dx,//TODO figure out an intelligent way to set these!
            dy = self.dy,
            i = 0,
            conns = [],
            attr,
            position,
            j;

        self.graph[ids[0]] = { 'base': self.graph[fsId].base, 'child': self.graph[fsId].child };//Add the files to the graph

        i = 0;
        //Next, we will create the rest of the files
        while(++i < names.length){
            attr = {};
            position = { 'x': pos.x+(i)*dx, 'y': pos.y+(i)*dy };

            id = self._createFile(names[i], position);
            self.graph[id] = { 'base': self.graph[fsId].base, 'child': self.graph[fsId].child };//Add the files to the graph
            ids.push(id);

            j = self.graph[fsId].base.length;
            while(j--){
                self.graph[self.graph[fsId].base[j]].child.push(id);
            }

            j = self.graph[fsId].child.length;
            while(j--){
                self.graph[this.graph[fsId].child[j]].base.push(id);
            }

        }

        return ids;
    };
    //transformed
    PegasusPlugin.prototype._createFileFromFileSet = function(fsId, doNotMove){//If doNotMove is true, it won't be moved
        var self = this,
            pos = JSON.parse(JSON.stringify(self.core.getMemberRegistry(self.activeNode, "Workspace", fsId, 'position') || self.core.getRegistry(self._nodeCache[fsId],'position'))),
            names = self._getFileNames(fsId),
            name = names[0],
            fileId,
            shift = { 'x': self.dx * (names.length-1)/2, 'y': self.dy * (names.length-1)/2 };//adjust pos by names and dx/dy

        if(!doNotMove){
            pos.x = Math.max(0, pos.x - shift.x);
            pos.y = Math.max(0, pos.y - shift.y);
        }

        fileId = self._createFile(name, pos);

        return { 'id': fileId, 'name': name, 'names': names, 'position': pos };
    };
    //transformed
    PegasusPlugin.prototype._createConnection = function(src, dst){
        var self = this,
            newConnection = self.core.createNode({parent:self.activeNode,base:self.META['PreviewConn']});

        self.core.setPointer(newConnection,'src',self._nodeCache[src]);
        self.core.setPointer(newConnection,'dst',self._nodeCache[dst]);

        self._nodeCache[self.core.getPath(newConnection)] = newConnection;
        return self.core.getPath(newConnection);
    };
    //transformed
    PegasusPlugin.prototype._createPreviewNode = function(id){
        //Creates the Preview_File/Job
        var self = this,
            node = self._nodeCache[id],
            name = self.core.getAttribute(node,'name'),
            pos = JSON.parse(JSON.stringify(self.core.getMemberRegistry(self.activeNode, "Workspace", id, 'position') || self.core.getRegistry(node,'position')));

        if(self._isTypeOf(node,self.META['File'])){
            return self._createFile(name,pos);
        }

        return self._createJob(name,self.core.getAttribute(node,'cmd'),pos);
    };
    //transformed
    PegasusPlugin.prototype._createFile = function(name, pos){
        //Create a file type only viewable in the "Preview" aspect: Preview_File
        var self = this,
            newFile;

        newFile = self.core.createNode({parent:self.activeNode,base:self.META['PreviewFile']});
        self.core.setAttribute(newFile,'name',name);
        self.core.setRegistry(newFile,'position',pos);

        self._nodeCache[self.core.getPath(newFile)] = newFile;

        return self.core.getPath(newFile);
    };
    //transformed
    PegasusPlugin.prototype._createJob = function(name, cmd, pos){
        //Create a file type only viewable in the "Preview" aspect: Preview_File
        var self = this,
            newJob;

        newJob = self.core.createNode({parent:self.activeNode,base:self.META['PreviewJob']});
        self.core.setAttribute(newJob,'name',name);
        self.core.setAttribute(newJob,'cmd',cmd);
        self.core.setRegistry(newJob,'position',pos);

        self._nodeCache[self.core.getPath(newJob)] = newJob;

        return self.core.getPath(newJob);
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

    return PegasusPlugin;
});
