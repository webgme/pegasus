define(['plugin/PluginConfig','plugin/PluginBase'],function(PluginConfig,PluginBase){

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
    PegasusPlugin.prototype.loadStartingNodes = function(callback){
        //we load the children of the active node
        var self = this;
        self._nodeCache = {};
        self.loadChildren(self.activeNode,function(err,children){
            if(err){
                callback(err)
            } else {
                for(var i=0;i<children.length;i++){
                    self._nodeCache[self.core.getPath(children[i])] = children[i];
                }
                callback(null);
            }
        });
    };
    PegasusPlugin.prototype.getMetaTypeByName = function(typeName){
        var self = this,
            keys = Object.keys(self.META);
        for(var i=0;i<keys.length;i++){
            if(self.core.getAttribute(self.META[keys[i]],'name') === typeName){
                return self.META[keys[i]];
            }
        }
        return null;
    };
    PegasusPlugin.prototype.isTypeOf = function(node,type){
        //now we make the check based upon path
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
        self.loadStartingNodes(function(err){
            if(err){
                //finishing
                self.result.success = false;
                callback(err,self.result);
            } else {
                //executing the plugin
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
    };


    PegasusPlugin.prototype._getChildrenAndClearPreview = function(){
        //This method gets the children ids and removes the preview nodes before returning it
        var childrenIds = this._client.getNode(this.currentObject).getChildrenIds(),
            deleteIds = [],
            i = -1;

        while(++i < childrenIds.length){
            if(this.pegasusTypeCheck.isInPreviewAspect(childrenIds[i]))
                deleteIds.push(childrenIds.splice(i--,1)[0]);
        }

        this._client.delMoreNodes(deleteIds);

        return childrenIds;
    };

    PegasusPlugin.prototype._createCopyLists = function(nIds){
        var forks;//Create lists out of lists

        //Next, for each path, I will resolve the dot operators then the filesets
        this._createGraph(nIds);
        forks = this._createSkeletonWorkflowAndGetForks();
        if(forks.length)
            this._copyForkGroups(forks);

        this._client.startTransaction();
        this._connectPreviewObjects();
        this._client.completeTransaction();
    };

    PegasusPlugin.prototype._createGraph = function(nIds){
        // I will create a dictionary of objects with pointers to the base/children
        // in the graph
        this.graph = {'start': []};
        var n,
            src,
            dst,
            nodes;

        //Order the nodes by the following rule:
        //If it is linked to the last node, add it
        //O.W. get the highest node
        while(nIds.length){
            //Create entries in the graph for all non-connection ids
            if(!this.pegasusTypeCheck.isConnection(nIds[0])/* && !this.pegasusTypeCheck.isInPreviewAspect(nIds[0])*/){//None should be in preview aspect

                if(!this.graph[nIds[0]])
                    this.graph[nIds[0]] = {'base': [], 'child': []};

            }else if(this.pegasusTypeCheck.isConnection(nIds[0]) ){//Connection
                n = this._client.getNode(nIds[0]);
                src = n.getPointer(CONSTANTS.POINTER_SOURCE).to;
                dst = n.getPointer(CONSTANTS.POINTER_TARGET).to;

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
        nodes = Object.keys(this.graph);
        for(var ids in this.graph){
            if(this.graph.hasOwnProperty(ids)){
                if(this.pegasusTypeCheck.isFileSet(ids) || this.pegasusTypeCheck.isFile(ids)){
                    if(this.graph[ids].base.length === 0)
                        this.graph['start'].push(ids);
                }
            }
        }
    };

    PegasusPlugin.prototype._createSkeletonWorkflowAndGetForks = function(){
        // Traverse/Update the graph and create the forks object
        var forks = [],
            nodeIds = this.graph.start,
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

        while(nodeIds.length){//BFS
            skip = false;
            del = false;
            preview = null;
            //If the next node is a fork
            //Create a fork object and add to "forks"
            if( this.pegasusTypeCheck.isFork(this.graph[nodeIds[0]].child[0]) ){
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

                delete this.graph[forkId];

            }else if( this.pegasusTypeCheck.isMerge(nodeIds[0]) ){//Close the most recent fork

                //Close the current fork
                mergeId = nodeIds[0];
                assert(currFork, "No current fork");
                currFork.end = this.graph[mergeId].base;

                assert(this.graph[mergeId].child.length === 1, "Merge operators can have only one node following");
                fsId = this.graph[mergeId].child[0];

                currFork = currFork.out;

                assert(this.graph[mergeId].child.length === 1, "Merge operator can only have one connection out");
                assert(this.pegasusTypeCheck.isFileSet(this.graph[nodeIds[0]].child[0]), "FileSet must follow a Merge operator");

                //Remove Merge object from graph
                nodeIds[0] = this.graph[mergeId].base[0];
                this._removeFromGraph(fsId);
                this._removeFromGraph(mergeId);

            }else if( this.pegasusTypeCheck.isFileSet(nodeIds[0]) ){//If the node is a fileset and next is not a fork
                ids = this._processFileSet(nodeIds[0]);             //Resolve the whole fileset and insert the additional files into the graph
                preview = ids[0];
                i = 0;

                while(++i < ids.length){
                    this.graph[ids[i]] = { 'base': this.graph[nodeIds[0]].base, 'child': this.graph[nodeIds[0]].child };
                }
                //j = nodeIds[0].base.length;
                //while(j--){
                //this._createConnection(nodeIds[0].base[j], ids[i]);//Create connection
                //}
            }else{//Else create preview node

                preview = this._createPreviewNode(nodeIds[0]);
            }

            //Add the children of nodeId to nodeIds
            if(skip){
                nodeIds = nodeIds.concat(this.graph[this.graph[nodeIds[0]].child].child);
            }else{
                nodeIds = nodeIds.concat(this.graph[nodeIds[0]].child);
            }

            //Replace nodeIds[0] with preview object
            if(preview){

                this._replaceInGraph(preview, nodeIds[0]);
            }

            nodeIds.splice(0,1);
        }

        return forks;
    };

    PegasusPlugin.prototype._copyForkGroups = function(forks){
        var outer = forks[0];

        //Find the outermost fork and copy it
        while(outer.out){
            outer = outer.out;
        }

        this._copyFork(outer);
    };

    PegasusPlugin.prototype._copyFork = function(fork){
        var i = fork.in.length,
            numCopies,
            startNames = [],
            endNames = [],
            copyRequest = {'parentId': this.outputId},
            nodes = [],
            ids,
            x1,
            x2,
            y1,
            y2,
            j;

        assert(fork.start && fork.end, "Fork missing a merge operator");

        //Start a transaction
        this._client.startTransaction();

        //Copy any inside forks
        while(i--){
            this._copyFork(fork.in[i]);
        }

        //Resolve the first and last file
        var fileObject = this._createFileFromFileSet(fork.start, true),
            sfile = fileObject.id;//start file

        startNames = fileObject.names;

        this._client.completeTransaction();
        this._client.startTransaction();

        //Insert the files into the graph
        this._replaceInGraph(sfile, fork.start);

        fork.start = sfile;

        //Get the number of copies needed from fork.start fileset
        numCopies = startNames.length;

        nodes.push(sfile);
        //Figure out the size of the current fork

        var pos;
        while(this.graph[nodes[0]] && this.graph[nodes[0]].base.indexOf(fork.end[0]) === -1){//BFS
            //Get the position info about entire box
            pos = this._client.getNode(nodes[0]).getRegistry('position');
            x1 = Math.min(x1, pos.x) || pos.x;
            x2 = Math.max(x2, pos.x) || pos.x;
            y1 = Math.min(y1, pos.y) || pos.y;
            y2 = Math.max(y2, pos.y) || pos.y;

            //Create list of nodes to copy
            copyRequest[nodes[0]] = { 'registry': { 'position': { 'x': pos.x , 'y': pos.y} }};
            //copyRequest[nodes[0]]['registry'][

            //Add next nodes
            nodes = nodes.concat(this.graph[nodes[0]].child);

            nodes.splice(0,1);
        }

        //Copy the nodes
        var dx = this.dx + (x2-x1),
            dy = this.dy + (y2-y1),
            nodeIds,
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
            copyRequest[sfile]['attributes'] = {};
            copyRequest[sfile]['attributes'][nodePropertyNames.Attributes.name] = startNames[i];

            //Shift each node
            for(var k in copyRequest){
                if(copyRequest.hasOwnProperty(k) && k !== 'parentId'){
                    copyRequest[k]['registry']['position'] = { 'x': x[k]+=dx, 'y': y[k] };
                }
            }

            //Insert nodes into graph
            nodeIds = this._client.copyMoreNodes(copyRequest);
            for(var k in nodeIds){
                if(nodeIds.hasOwnProperty(k)){//Insert the node copy into our graph

                    if(this.graph.start.indexOf(k) !== -1)
                        this.graph.start.push(nodeIds[k]);

                    this.graph[nodeIds[k]] = { 'base': [], 'child': [] };
                    j = this.graph[k].base.length;
                    while(j--){
                        base = this.graph[k].base[j];

                        if(nodeIds[base]){
                            this.graph[nodeIds[k]].base.push(nodeIds[base]);//Set the base of the new point
                        }else{
                            this.graph[nodeIds[k]].base.push(base);//Set the base of the new point
                            this.graph[base].child.push(nodeIds[k]);
                        }
                    }

                    j = this.graph[k].child.length;
                    while(j--){
                        child = this.graph[k].child[j];

                        if(nodeIds[child]){
                            this.graph[nodeIds[k]].child.push(nodeIds[child]);//Set the child of the new point
                        }else{
                            this.graph[nodeIds[k]].child.push(child);//Set the child of the new point
                            this.graph[child].base.push(nodeIds[k]);
                        }
                    }

                }
            }
        }

        //Finish the transaction
        this._client.completeTransaction();
    };

    PegasusPlugin.prototype._connectPreviewObjects = function(){
        var nodeIds = this.graph['start'],
            visited = {},//dictionary of visited nodes
            j;

        while(nodeIds.length){
            if(visited[nodeIds[0]]){
                nodeIds.splice(0,1);
                continue;
            }

            j = this.graph[nodeIds[0]].base.length;

            while(j--){
                this._createConnection(this.graph[nodeIds[0]].base[j], nodeIds[0]);
            }

            nodeIds = nodeIds.concat(this.graph[nodeIds[0]].child);
            visited[nodeIds.splice(0,1)[0]] = true;
        }
    };

    PegasusPlugin.prototype._replaceInGraph = function(nodes, original){
        var j = this.graph.start.indexOf(original);
        nodes = nodes instanceof Array ? nodes : [nodes];

        this._addToGraph(nodes, original);

        if(j !== -1)
            this.graph.start.splice(j,1);

        delete this.graph[original];
    };

    PegasusPlugin.prototype._addToGraph = function(nodes, original){
        nodes = nodes instanceof Array ? nodes : [ nodes ];
        var node,
            isStart = this.graph.start.indexOf(original) > -1,
            k = nodes.length,
            j,
            i;

        while(k--){
            node = nodes[k];

            if(isStart)
                this.graph.start.push(node);

            //Set the node's child/base ptrs
            this.graph[node] = this.graph[original];

            i = this.graph[original].base.length;//Set all bases' children ptrs
            while(i--){
                if(this.graph[this.graph[original].base[i]].child.indexOf(node) !== -1)//Kinda hacky
                    continue;

                j = this.graph[this.graph[original].base[i]].child.indexOf(original);
                if(j !== -1){
                    this.graph[this.graph[original].base[i]].child.splice(j, 1, node); //replace original with node
                }else{
                    this.graph[this.graph[original].base[i]].child.push(node); //replace original with node
                }
            }

            i = this.graph[original].child.length;
            while(i--){//Set all children's base ptrs
                if(this.graph[this.graph[original].child[i]].base.indexOf(node) !== -1)
                    continue;

                j = this.graph[this.graph[original].child[i]].base.indexOf(original);
                if(j !== -1){
                    this.graph[this.graph[original].child[i]].base.splice(j, 1, node); //replace original with node
                }else{
                    this.graph[this.graph[original].child[i]].base.push(node); //replace original with node
                }
            }
        }
    };

    PegasusPlugin.prototype._removeFromGraph = function(node){
        //Remove node from graph and splice the base to point to children
        assert(this.graph[node], "Can't remove non-existent node from graph!");

        var children = this.graph[node].child,
            bases = this.graph[node].base,
            i = children.length,
            j,
            k;

        //Connect children to base
        while(i--){
            j = bases.length;
            k = this.graph[children[i]].base.indexOf(node);
            if(k !== -1)
                this.graph[children[i]].base.splice(k, 1);

            while(j--){
                if(this.graph[children[i]].base.indexOf(bases[j]) === -1){
                    this.graph[children[i]].base.push(bases[j]);
                }
            }
        }

        //Connect base to children
        i = bases.length;
        while(i--){
            j = children.length;
            k = this.graph[bases[i]].child.indexOf(node);

            if(k !== -1)
                this.graph[bases[i]].child.splice(k, 1);
            while(j--){
                if(this.graph[bases[i]].child.indexOf(children[j]) === -1){
                    this.graph[bases[i]].child.push(children[j]);
                }
            }
        }

        delete this.graph[node];
    };

    PegasusPlugin.prototype._processFileSet = function(fsId){//return ids: [ first file, ... rest ]
        var fileObject = this._createFileFromFileSet(fsId),
            ids = [ fileObject.id ],
            id,
            names = fileObject.names,
            pos = { 'x': fileObject.position.x, 'y': fileObject.position.y },
            dx = this.dx,//TODO figure out an intelligent way to set these!
            dy = this.dy,
            i = 0,
            conns = [],
            attr,
            position,
            j;

        this.graph[ids[0]] = { 'base': this.graph[fsId].base, 'child': this.graph[fsId].child };//Add the files to the graph

        i = 0;
        //Next, we will create the rest of the files
        while(++i < names.length){
            attr = {};
            position = { 'x': pos.x+(i)*dx, 'y': pos.y+(i)*dy };

            id = this._createFile(names[i], position);
            this.graph[id] = { 'base': this.graph[fsId].base, 'child': this.graph[fsId].child };//Add the files to the graph
            ids.push(id);

            j = this.graph[fsId].base.length;
            while(j--){
                this.graph[this.graph[fsId].base[j]].child.push(id);
            }

            j = this.graph[fsId].child.length;
            while(j--){
                this.graph[this.graph[fsId].child[j]].base.push(id);
            }

        }

        return ids;
    };

    PegasusPlugin.prototype._createFileFromFileSet = function(fsId, doNotMove){//If doNotMove is true, it won't be moved
        var pos = { 'x': this._client.getNode(fsId).getRegistry('position').x,//FIXME shouldn't be hardcoded
                'y': this._client.getNode(fsId).getRegistry('position').y },
            names = this._getFileNames(fsId),
            name = names[0],
            fileId,
            shift = { 'x': this.dx * (names.length-1)/2, 'y': this.dy * (names.length-1)/2 };//adjust pos by names and dx/dy

        if(!doNotMove){
            pos.x = Math.max(0, pos.x - shift.x);
            pos.y = Math.max(0, pos.y - shift.y);
        }

        fileId = this._createFile(name, pos);

        return { 'id': fileId, 'name': name, 'names': names, 'position': pos };
    };

    PegasusPlugin.prototype._createConnection = function(src, dst){
        var baseId = this.pegasusTypes.PreviewConn,
            connId;

        connId = this._client.createChild({ 'parentId': this.outputId, 'baseId': baseId });
        this._client.makePointer(connId, CONSTANTS.POINTER_SOURCE, src);
        this._client.makePointer(connId, CONSTANTS.POINTER_TARGET, dst);
        return connId;
    };

    PegasusPlugin.prototype._createPreviewNode = function(id){
        //Creates the Preview_File/Job
        var node = this._client.getNode(id),
            name = node.getAttribute(nodePropertyNames.Attributes.name),
            pos = node.getRegistry('position');

        if(this.pegasusTypeCheck.isFile(id)){

            id = this._createFile(name, pos);

        }else {//if(this.pegasusTypeCheck.isJob(id)){

            var cmd = node.getAttribute('cmd') || "MACRO";
            id = this._createJob(name, cmd, pos);

        }

        return id;
    };

    PegasusPlugin.prototype._createFile = function(name, pos){
        //Create a file type only viewable in the "Preview" aspect: Preview_File
        var baseId = this.pegasusTypes.PreviewFile,
            fileId;

        fileId = this._client.createChild({ 'parentId': this.outputId, 'baseId': baseId });

        this._client.setAttributes(fileId, nodePropertyNames.Attributes.name, name || "File_1");//Set name
        this._client.setRegistry(fileId, 'position', pos);//Set position

        return fileId;
    };

    PegasusPlugin.prototype._createJob = function(name, cmd, pos){
        //Create a file type only viewable in the "Preview" aspect: Preview_File
        var baseId = this.pegasusTypes.PreviewJob,
            jobId;

        jobId = this._client.createChild({ 'parentId': this.outputId, 'baseId': baseId });

        this._client.setAttributes(jobId, nodePropertyNames.Attributes.name, name);//Set name
        this._client.setAttributes(jobId, 'cmd', cmd);//Set name
        this._client.setRegistry(jobId, 'position', pos);//Set position

        return jobId;
    };

    PegasusPlugin.prototype._getFileNames = function(fsId){//FileSet node
        var fs = this._client.getNode(fsId),
            filenames = fs.getAttribute('filenames'),
            names = [],
            k = filenames.indexOf('['),
            basename = filenames.slice(0,k) + "%COUNT" + filenames.slice(filenames.lastIndexOf(']')+1),
            i = filenames.slice(k+1),
            j;//Only supports one set of numbered input for now

        j = parseInt(i.slice(i.indexOf('-')+1, i.indexOf(']')));
        i = parseInt(i.slice(0,i.indexOf('-')));

        k = Math.max(i,j);
        i = Math.min(i,j)-1;

        if(isNaN(i+j))
            names = [filenames];

        while(i++ < j){
            names.push(basename.replace("%COUNT", i));
        }

        return names;
    };

    return PegasusPlugin;
});