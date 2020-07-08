const path = require('path');
const fs = require('fs');
const webpack = require('webpack');
const CopyWebPackPlugin = require('copy-webpack-plugin');
const HTMLWebPackPlugin = require('html-webpack-plugin');
const Terser = require('terser-webpack-plugin')
const rimraf = require("rimraf");
const tsloader = require.resolve('ts-loader');
const merge = require("webpack-merge");
const config = require('./TestPlayer.config.js')

module.exports = (env = {}) => {

	var isProd = !!env.prod;

	// force some configs dependant on prod and dev
	config.rt_debug = isProd ? false : config.rt_debug;

	config.rt_showFPS = isProd ? false : config.rt_showFPS;

	config.cacheBuster = isProd ? false : config.cacheBuster;

	config.allowURLSearchParams = isProd ? false : config.allowURLSearchParams;

	// split mode right now errors in watch mode
	config.split = isProd ? config.split : false;

	if (config.debugConfig) {
		console.log("global config used for webpack:");
		for (var key in config) {
			console.log("	- config." + key, config[key]);
		}
	}

	const entry = {};
	entry[config.entryName] = [config.entryPath];

	let plugins = processConfig(config, __dirname, CopyWebPackPlugin, HTMLWebPackPlugin, webpack.BannerPlugin, fs, rimraf, path);

	const common = {

		entry: entry,

		output: {
			pathinfo: false,
			path: path.join(__dirname, "bin"),
			filename: 'js/[name].js'
		},
		resolve: {
			// Add `.ts` and `.tsx` as a resolvable extension.
			extensions: ['.webpack.js', '.web.js', '.js', '.ts', '.tsx']
		},
		module: {
			rules: [
				// all files with a `.ts` or `.tsx` extension will be handled by `awesome-typescript-loader`
				{ test: /\.ts(x?)/, exclude: /node_modules/, loader: tsloader, options: { experimentalWatchApi: true } },

				// all files with a `.js` or `.jsx` extension will be handled by `source-map-loader`
				//{ test: /\.js(x?)/, loader: require.resolve('source-map-loader') }
			]
		},
		plugins: plugins,

		performance: {
			hints: false // wp4
		},
		stats: {
			cached: true, // wp4
			errorDetails: true, // wp4
			colors: true // wp4
		},
		devServer: {
			progress: true, // wp4
		},


	}

	const dev = {
		mode: "development",// wp4
		devtool: 'source-map',
		//devtool: 'cheap-module-eval-source-map',//use this option for recompiling libs
		devServer: {
			contentBase: path.join(process.cwd(), "src"),
			inline: true,
			publicPath: "/",
			open: false,
			progress: true,

		},
		optimization: {
			//minimize: false // wp4
		}
	}

	const prod = {
		mode: "production",// wp4
		bail: true
	};

	if (Terser) {
		prod.optimization = {
			minimize: true,
			minimizer: [
				new Terser({
					extractComments: {
						condition: /^\**!|@preserve|@license|@cc_on/i,
						filename: 'LICENSES.txt'
					},
				}),
			],
		}
	} else {
		console.warn("TERSER IS REQUIRE FOR REMOVING COMMENTS!");
	}

	return merge(common, isProd ? prod : dev);

}

// process config
// return a list of webpack-plugins
const processConfig = (config, rootPath, CopyWebPackPlugin, HTMLWebPackPlugin, BannerPlugin, fs, rimraf, path) => {

	var plugins = [];

	if (config.buildinsPath && config.buildinsPath.length) {
		plugins.push(new CopyWebPackPlugin([
			{ from: config.buildinsPath, to: 'assets/builtins' },
		]));
	}

	plugins.push(new CopyWebPackPlugin([
		{ from: config.loaderTemplate, to: 'js' },
	]));

	// collect all game-urls to create a index.html:
	let gameURLS = {};

	// map to collect copied resources, so we preent any redunant copies
	let copiedResources = {};

	var fileConfig = config;
	var outputPath = "";

	plugins.push(new CopyWebPackPlugin([
		{ from: path.join(rootPath, "src", "tests"), to: outputPath + "assets" },
	]));

	// create/prepare config props needed for runtime

	var configForHTML = getConfig(fileConfig, config);

	configForHTML.binary = [];
	// copy and prepare resources for html 
	let resources = getConfigProp(fileConfig, config, "resources");
	if (resources && resources.length > 0) {
		for (let r = 0; r < resources.length; r++) {
			let res_path = path.join(rootPath, resources[r]);
			let res_name = path.basename(res_path);
			let res_outputPath = outputPath + "assets/" + res_name;
			let res_filesize = copiedResources[res_outputPath];
			if (!res_filesize) {
				// only need to copy if it has not yet been done
				if (!fs.existsSync(res_path)) {
					throw ("invalid filename path for resource " + res_path);
				}
				plugins.push(new CopyWebPackPlugin([
					{ from: res_path, to: outputPath + "assets" },
				]));
				stats = fs.statSync(res_path);
				res_filesize = stats["size"];
				copiedResources[res_outputPath] = res_filesize;
			}
			configForHTML.binary.push({
				name: res_name,
				path: res_outputPath,
				size: res_filesize,
			});
		}
	}
	let assets = getConfigProp(fileConfig, config, "assets");
	if (assets && assets.length > 0) {
		for (let r = 0; r < assets.length; r++) {
			let res_path = path.join(rootPath, assets[r]);

			if (!fs.existsSync(res_path)) {
				throw ("invalid filename path for asset " + res_path);
			}
			plugins.push(new CopyWebPackPlugin([
				{ from: res_path, to: outputPath + "assets" },
			]));

		}
	}


	if (configForHTML.splash)
		configForHTML.splash = "assets/" + configForHTML.splash;

	if (configForHTML.start)
		configForHTML.start = "assets/" + configForHTML.start;


	var runtimePath = "js/" + config.entryName + ".js";
	configForHTML["runtime"] = runtimePath;


	// create string for html inject (incl hack to handle functions): 

	var collectedFunctions = collectAndReplaceFunctions({}, configForHTML);
	var configStr = "\nconfig = " + JSON.stringify(configForHTML, null, 4) + ";\n";
	var jsStringForHTML = "";
	var allFunctions;
	if (Object.keys(collectedFunctions).length > 0) {
		jsStringForHTML = "\nlet allFunctions = {};\n";
		for (var key in collectedFunctions) {
			jsStringForHTML += "allFunctions['" + key + "'] = " + collectedFunctions[key].toString() + ";\n";
		}
		jsStringForHTML += configStr;
		jsStringForHTML += "\nlet connectConfigToFunctions =" + (function (obj) {
			for (var key in obj) {
				if (typeof obj[key] == "string" && obj[key].indexOf("___") === 0) {
					obj[key] = allFunctions[obj[key].replace("___", "")];
				}
				if (typeof obj[key] == "object")
					connectConfigToFunctions(obj[key]);
			}
		}).toString() + ";\n";
		jsStringForHTML += "\nconnectConfigToFunctions(config);\n";
	}
	else {
		jsStringForHTML += configStr;
	}

	// code to overwrite config by URLSearchParams
	if (config.allowURLSearchParams) {
		jsStringForHTML += "const q = new URLSearchParams(location.search);\n";
		jsStringForHTML += "for (let key of q.keys()){ config[key] = q.get(key);};\n";
	}

	// add cachebuster
	if (config.cacheBuster) {
		jsStringForHTML += "for (let key in config.binary){ config.binary[key].path = config.binary[key].path+'?v='+Math.random();};\n";
	}


	//	copy and mod html:

	var htmlOutputPath = "index.html";
	gameURLS[fileConfig.rt_filename] = {
		path: htmlOutputPath,
		name: configForHTML.title
	};

	var htmlSourcePath = getConfigProp(fileConfig, config, "gameTemplate");

	if (config.debugConfig) {
		console.log("### " + configForHTML.title + " CONFIG THAT WILL BE INJECTED INTO HTML");
		for (var key in configForHTML) {
			console.log("			- config." + key, configForHTML[key]);
		}
	}

	plugins.push(new CopyWebPackPlugin([
		{
			from: htmlSourcePath,
			to: htmlOutputPath,
			transform: function (content, src) {
				return content.toString()
					.replace(/INSERT_TITLE/g, configForHTML.title ? configForHTML.title : "UNTITLED")
					.replace(/INSERT_SPLASHSCREEN/g, configForHTML.splash)
					.replace(/INSERT_CODE/g, jsStringForHTML);
			}
		}
	]));


	return plugins;
}

// get config prop from file-config, or from global-config if it doesnt eists
var getConfigProp = function (fileconfig, config, name) {
	return fileconfig[name] ? fileconfig[name] : config[name];
};

// get a config for a game-file.
// this filters out all props that are not prefixed by "rt_"
// also takes care that it uses props from global-config if file-config does not provide it
// this can probably be done better and cleaner
// but for now it should do the job
var getConfig = function (fileconfig, config) {
	var newConfig = {};
	for (var key in fileconfig) {
		if (key.indexOf("rt_") == 0) {
			newConfig[key.replace("rt_", "")] = fileconfig[key];
		}
	}
	for (var key in config) {
		if (key.indexOf("rt_") == 0 && !newConfig.hasOwnProperty(key.replace("rt_", ""))) {
			newConfig[key.replace("rt_", "")] = config[key];
		}
	}

	return newConfig;
};

// collect all js-functions found in config obj and replace them with string-id
// we will inject the functions sepperatly, so we can inject config as json string
// we also inject a function that wires the collected functions back to the js-obj
// this way we can support injecting simple js-function into the html (dont use "this" in functions)
var collectAndReplaceFunctions = function (collectedFunctions, obj, path) {
	if (path === void 0) { path = ""; }
	if (path != "") { path += ""; }
	if (typeof obj === "object") {
		for (var key in obj) {
			if (typeof obj[key] === "function") {
				collectedFunctions[path + key] = obj[key];
				obj[key] = "___" + path + key;
			}
			else {
				collectedFunctions = collectAndReplaceFunctions(collectedFunctions, obj[key], path + key);
			}
		}
	}
	return collectedFunctions;
};
