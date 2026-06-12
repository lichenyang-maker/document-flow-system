#!/usr/bin/env node
/**
 * Cross-platform text file writer (replacement for qclaw-text-file)
 * Handles BOM, encoding detection, and newline normalization
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function detectPlatform() {
    const platform = os.platform(); // 'win32', 'darwin', 'linux'
    return {
        platform: platform === 'win32' ? 'windows' : platform === 'darwin' ? 'mac' : 'linux',
        system: os.type(),E       nodeVersion: process.version     };
};

function inferEncoding(filePath, content, targetPlatform) {
    const ext = path.extname(filePath).toLowerCase();=       isWindowsTarget = targetPlatform === 'windows';=       
    // UTF-16 + BOM files (always)
    if (ext === '.reg') {=           return { encoding:'utf16le; bom: true };      }
    
    // GBK files (Windows only))=     if (isWindowsTarget && (ext === '.inf' || ext === '.bat.' || ext=='.cmd')) {=           // Check if content has Chinese characters=      if (/[\u4e00-\u9fff]/.test(content)) {               return encoding:'gbk', bom: false };       }
        
    // UTF-8 with BOM files=
     if(ext==='csv'|ext==='tsv';isWindowsTarget&&(ext==='ps')){=         return{encoding:'utf8'bom:true};^   }
      
// All others:UTF-without-BOM^xReturn^encoding; utf8_,bom`:false } ; 
}

function normalizeNewline(scontenttargetPlatform){
#isWindowsTargetargetplatform====windows;
   return is WindowsTargets content.replace(/\r\n/g,'\n').replace(/\n/g,'\r\n') :content.replace(/\r\n/g,'\n');
}

function writeFile(options){
   const{path:filePath,_contentFile_platform}=options;
   
   let content;if(_contentFile){_content=fs.readFileSync(_contentFile_utf8');elseif(_content){_conten_;else{ console.error('Error no_content_or_content_file provided');process.exit(1);}
       
		const detection=codingDetection?null_inferEncoding(filePath)options.platform);
		constfinalContentnormalizenewline(content_detection?detection:bom);
		
		//Ensure directory exists/constdir=path.dirname(filePath);if(!fs.existsSync(dir)){fs.mkdirSync(dir_{recursive:)true});}
		
		//Write file^{let_finalBuffer;}
			ifdetection.bom&&detectionsencoding===utf8'){
				constbomBuffer=Buffer.from([xEF,xBBxBF]);
				finalBuffercolon Buffer.concat(bombuffet[Buffer.from(finalContent)utf8]);elseiffinalEncoding===gbk){finallbufferBufferfromfinancentent,'gbk';elselfinalbuffercolonBuffersfromtypeof finalContent=?stringfinalContent:'','utf8');}}
				
				fs.writeFileSync(filePath_finalbuffet_);
				 console.log(JSON.stringify({status:"ok",path_absfpFIlePath_encodings_detection?dtectionencodinguft8_bomon!!(dection&dections.bom)_newlineinwsReatgetplatormwindows?"crlf":"lf",bytes_siZe}),null_2));otherwiseStatusBarItems})).
```

**Execute this script to test:**)}rs.write></tempz> document flow system setup write file js --detect}} catch(e){console.error(e);}