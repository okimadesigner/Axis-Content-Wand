figma.showUI(__html__, { width: 520, height: 800, themeColors: true });

let selectedTextNodes: any[] = [];
let currentSelectedFrameId: string | null = null;

const BATCH_SIZE = 20;
const MAX_PARALLEL_BATCHES = 3;

// Enhanced state tracking for fixed text with expiration
let fixedTextRegistry = new Map<string, {
  originalText: string;
  correctedText: string;
  fixedAt: number;
  layerId: string;
  selectionContext: string; // Track which selection context this belongs to
}>();

// Session-based recently fixed tracking
let recentlyFixedInCurrentSession = new Map<string, {
  fixedAt: number;
  selectionContext: string;
}>();

// Text normalization to match API behavior
const normalizeText = (text: string): string => {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\u00A0/g, ' ')
    .replace(/\u2013|\u2014/g, '-')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u201C|\u201D/g, '"')
    .normalize('NFC');
};

// Create text fingerprint for duplicate detection
const createTextFingerprint = (text: string): string => {
  const normalized = normalizeText(text);
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36).slice(0, 12);
};

// Helper function to load fonts for a given Figma node
const loadNodeFonts = async (figmaNode: TextNode) => {
  const fontName = figmaNode.fontName;
  if (fontName === figma.mixed) {
    const uniqueFonts: any[] = [];
    for (let i = 0; i < figmaNode.characters.length; i++) {
      const charFont = figmaNode.getRangeFontName(i, i + 1);
      if (charFont === figma.mixed) continue;
      
      const exists = uniqueFonts.some(font =>
        font.family === charFont.family && font.style === charFont.style
      );
      if (!exists) uniqueFonts.push(charFont);
    }
    await Promise.all(uniqueFonts.map(font => figma.loadFontAsync(font)));
  } else {
    await figma.loadFontAsync(fontName);
  }
};

// Create selection context identifier
const createSelectionContext = (selection: readonly SceneNode[]): string => {
  if (!selection.length) return 'empty';
  
  const sortedIds = selection.map(node => node.id).sort();
  return sortedIds.join(',');
};

// Clean expired entries from registries
const cleanupExpiredEntries = () => {
  const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
  const oneHourAgo = Date.now() - (60 * 60 * 1000);

  // Clean fixed text registry - be more aggressive
  for (const [fingerprint, record] of fixedTextRegistry) {
    if (record.fixedAt < oneHourAgo) {
      fixedTextRegistry.delete(fingerprint);
    }
  }

  // Clean recently fixed tracking
  for (const [nodeId, record] of recentlyFixedInCurrentSession) {
    if (record.fixedAt < fiveMinutesAgo) {
      recentlyFixedInCurrentSession.delete(nodeId);
    }
  }

  // Add size limits
  if (fixedTextRegistry.size > 1000) {
    const entries = Array.from(fixedTextRegistry.entries());
    entries.sort((a, b) => a[1].fixedAt - b[1].fixedAt);
    const toDelete = entries.slice(0, 500);
    toDelete.forEach(([key]) => fixedTextRegistry.delete(key));
  }
};

// Auto cleanup every 2 minutes
setInterval(cleanupExpiredEntries, 2 * 60 * 1000);

// Check if text appears to be already fixed/compliant
const isLikelyCompliantText = (text: string, nodeId?: string): boolean => {
  const normalized = normalizeText(text).toLowerCase();
  
  // Check if this node was recently fixed in current session
  if (nodeId && recentlyFixedInCurrentSession.has(nodeId)) {
    return true;
  }
  
  // Check if this exact text was recently fixed
  for (const [fingerprint, record] of fixedTextRegistry) {
    if (normalizeText(record.correctedText).toLowerCase() === normalized) {
      return true;
    }
  }
  
  // Heuristic checks for compliant text patterns
  const complianceIndicators = [
    /^[A-Z].*[.!?]$/,
    /\bminimum\b/,
    /\bplease\b.*\binvest\b/,
    /\bto\s+(meet|fulfill|comply|satisfy)\b/,
    /₹\d+/,
  ];
  
  const violationPatterns = [
    /\bmin\b(?!\w)/,
    /\bRs\.?\s*\d/,
    /\b(u|ur|pls|thru)\b/,
    /^[a-z]/,
    /[^.!?]$/,
  ];
  
  const hasCompliantPattern = complianceIndicators.some(pattern => pattern.test(normalized));
  const hasViolation = violationPatterns.some(pattern => pattern.test(normalized));
  
  return hasCompliantPattern && !hasViolation;
};

// Extract only visible text nodes with meaningful content
const extractTextNodesFromFrame = (frame: any): any[] => {
  const textNodes: any[] = [];
  
  const traverse = (node: any) => {
    if (!node.visible) return;
    
    if (node.type === 'TEXT') {
      const content = node.characters?.trim();
      if (content && content.length > 0) {
        const isCompliant = isLikelyCompliantText(content, node.id);
        textNodes.push({
          id: node.id,
          name: node.name,
          characters: content,
          node: node,
          fingerprint: createTextFingerprint(content),
          likelyCompliant: isCompliant,
          recentlyFixed: recentlyFixedInCurrentSession.has(node.id)
        });
      }
    }
    
    if ('children' in node && node.visible) {
      node.children.forEach(traverse);
    }
  };
  
  traverse(frame);
  return textNodes;
};

// Get visible text nodes from selection
const getTextNodesFromSelection = (selection: readonly SceneNode[]): any[] => {
  return selection
    .filter(node => node.visible && node.type === 'TEXT')
    .map(node => {
      const content = (node as TextNode).characters?.trim();
      if (!content) return null;
      
      const isCompliant = isLikelyCompliantText(content, node.id);
      return {
        id: node.id,
        name: node.name,
        characters: content,
        node: node,
        fingerprint: createTextFingerprint(content),
        likelyCompliant: isCompliant,
        recentlyFixed: recentlyFixedInCurrentSession.has(node.id)
      };
    })
    .filter(Boolean);
};

// Reset state when selection context changes significantly
const resetStateForNewSelection = (newSelectionContext: string) => {
  // Clean up expired entries
  cleanupExpiredEntries();
  
  // Clear recently fixed for different selection contexts
  const currentTime = Date.now();
  for (const [nodeId, record] of recentlyFixedInCurrentSession) {
    // Keep recently fixed items only if they're very recent (last 30 seconds) or in same context
    if (record.selectionContext !== newSelectionContext && 
        currentTime - record.fixedAt > 30000) {
      recentlyFixedInCurrentSession.delete(nodeId);
    }
  }
};

// Send enhanced selection info to UI
const updateSelectionInfo = () => {
  const selection = figma.currentPage.selection;
  const selectionContext = createSelectionContext(selection);
  
  // Reset state if selection context changed significantly
  resetStateForNewSelection(selectionContext);
  
  let frameId: string | null = null;
  let hasTextLayers = false;
  let hasFrames = false;
  let totalVisibleTextLayers = 0;
  let likelyCompliantLayers = 0;
  let recentlyFixedLayers = 0;
  
  selection.forEach(node => {
    if (!node.visible) return;
    
    if (node.type === 'TEXT') {
      const content = (node as TextNode).characters?.trim();
      if (content) {
        hasTextLayers = true;
        totalVisibleTextLayers++;
        if (isLikelyCompliantText(content, node.id)) {
          likelyCompliantLayers++;
        }
        if (recentlyFixedInCurrentSession.has(node.id)) {
          recentlyFixedLayers++;
        }
      }
    } else if (['FRAME', 'COMPONENT', 'INSTANCE'].indexOf(node.type) !== -1) {
      hasFrames = true;
      if (!frameId) frameId = node.id;
      const frameTextNodes = extractTextNodesFromFrame(node);
      totalVisibleTextLayers += frameTextNodes.length;
      likelyCompliantLayers += frameTextNodes.filter(n => n.likelyCompliant).length;
      recentlyFixedLayers += frameTextNodes.filter(n => n.recentlyFixed).length;
    }
  });
  
  figma.ui.postMessage({
    type: 'selection-changed',
    frameId,
    selectionInfo: {
      hasTextLayers,
      hasFrames,
      totalSelected: selection.length,
      totalVisibleTextLayers,
      likelyCompliantLayers,
      recentlyFixedLayers,
      canAnalyze: hasTextLayers || hasFrames,
      complianceEstimate: totalVisibleTextLayers > 0 ? 
        Math.round((likelyCompliantLayers / totalVisibleTextLayers) * 100) : 0,
      selectionContext
    }
  });
  
  currentSelectedFrameId = frameId;
};

// Track selection changes
figma.on('selectionchange', updateSelectionInfo);

// Handle UI messages
figma.ui.onmessage = async (msg: any) => {
  switch (msg.type) {
    case 'get-selection-info':
      updateSelectionInfo();
      break;
      
    case 'close-plugin':
      figma.closePlugin();
      break;
      
    case 'analyze-selection':
      try {
        const selection = figma.currentPage.selection;
        if (!selection.length) {
          figma.ui.postMessage({
            type: 'error',
            message: 'Please select text layers or frames'
          });
          return;
        }
        
        const selectionContext = createSelectionContext(selection);
        let textNodes: any[] = [];
        let analysisType = '';
        let contextName = '';
        
        // Check for direct text selection first
        const directTextNodes = getTextNodesFromSelection(selection);
        
        if (directTextNodes.length > 0) {
          textNodes = directTextNodes;
          analysisType = 'text-layers';
          contextName = directTextNodes.length === 1 ? 
            directTextNodes[0].name : 
            `${directTextNodes.length} text layers`;
        } else {
          // Look for frames
          const frameNodes = selection.filter(node => 
            node.visible && ['FRAME', 'COMPONENT', 'INSTANCE'].indexOf(node.type) !== -1
          );
          
          if (!frameNodes.length) {
            figma.ui.postMessage({
              type: 'error',
              message: 'Select visible text layers or frames'
            });
            return;
          }
          
          frameNodes.forEach(frame => {
            textNodes.push(...extractTextNodesFromFrame(frame));
          });
          
          analysisType = 'frame';
          contextName = frameNodes.length === 1 ? 
            frameNodes[0].name : 
            `${frameNodes.length} frames`;
        }
        
        if (!textNodes.length) {
          figma.ui.postMessage({
            type: 'error',
            message: 'No visible text content found'
          });
          return;
        }
        
        selectedTextNodes = textNodes;
        
        // OPTIMIZATION: Filter out recently fixed and likely compliant text for API analysis
        const needsAnalysis = textNodes.filter(node => 
          !node.recentlyFixed && !node.likelyCompliant
        );
        
        const alreadyCompliant = textNodes.filter(node => 
          node.recentlyFixed || node.likelyCompliant
        );
        
        console.log(`📊 Analysis optimization: ${needsAnalysis.length} need analysis, ${alreadyCompliant.length} already compliant`);
        
        // Enhanced payload - only send non-compliant text for analysis
        const textLayers = needsAnalysis.map(node => ({
          id: node.id,
          name: node.name,
          text: node.characters,
          fingerprint: node.fingerprint,
          likelyCompliant: false // These are the ones that need analysis
        }));
        
        // Add already compliant items to the payload with metadata
        const compliantLayers = alreadyCompliant.map(node => ({
          id: node.id,
          name: node.name,
          text: node.characters,
          fingerprint: node.fingerprint,
          likelyCompliant: true,
          recentlyFixed: node.recentlyFixed
        }));
        
        const compliantCount = alreadyCompliant.length;
        const totalCount = textNodes.length;

        // NEW: Split layers into batches
        const allLayers = [...textLayers, ...compliantLayers];
        // const needsAnalysis = textLayers; // Only non-compliant - already declared above

        figma.ui.postMessage({
          type: 'text-extracted',
          textLayers: allLayers,
          analyzeOnlyLayers: needsAnalysis,
          totalLayers: totalCount,
          compliantLayers: compliantCount,
          needsAnalysisCount: needsAnalysis.length,
          batchInfo: {
            totalBatches: Math.ceil(needsAnalysis.length / BATCH_SIZE),
            batchSize: BATCH_SIZE
          }, // NEW
          frameId: analysisType === 'frame' ? selection[0].id : null,
          contextName,
          analysisType,
          selectionContext,
          optimizationHint: compliantCount > totalCount * 0.7 ? 'mostly_compliant' : 'needs_analysis'
        });
        
      } catch (error: any) {
        figma.ui.postMessage({
          type: 'error',
          message: `Error: ${error.message}`
        });
      }
      break;
      
    case 'apply-fix':
      try {
        const { nodeId, newContent } = msg;
        const selectionContext = createSelectionContext(figma.currentPage.selection);
        
        console.log(`🔧 Applying fix to node ${nodeId}: "${newContent}"`);
        
        const textNode = selectedTextNodes.find(node => node.id === nodeId);
        
        if (!textNode) {
          console.error(`❌ Text node ${nodeId} not found in selectedTextNodes`);
          figma.ui.postMessage({
            type: 'error',
            message: 'Text node not found - please re-select and analyze'
          });
          return;
        }
        
        const figmaNode = textNode.node;
        
        if (!figmaNode || figmaNode.type !== 'TEXT') {
          console.error(`❌ Invalid node type for ${nodeId}`);
          figma.ui.postMessage({
            type: 'error',
            message: 'Invalid text node - please re-select and analyze'
          });
          return;
        }
        
        // Check node accessibility
        try {
          const testAccess = figmaNode.characters;
        } catch (accessError: any) {
          console.error(`❌ Cannot access node ${nodeId}:`, accessError);
          figma.ui.postMessage({
            type: 'error',
            message: 'Text layer is no longer accessible - please re-select and analyze'
          });
          return;
        }
        
        // Load fonts before updating
        await loadNodeFonts(figmaNode);
        
        // Apply the fix
        const oldContent = figmaNode.characters;
        figmaNode.characters = newContent;
        
        // Update our local cache and registry
        textNode.characters = newContent;
        
        // Register this fix to prevent re-analysis
        const oldFingerprint = createTextFingerprint(oldContent);
        const newFingerprint = createTextFingerprint(newContent);
        
        fixedTextRegistry.set(newFingerprint, {
          originalText: oldContent,
          correctedText: newContent,
          fixedAt: Date.now(),
          layerId: nodeId,
          selectionContext
        });
        
        // Track as recently fixed in current session
        recentlyFixedInCurrentSession.set(nodeId, {
          fixedAt: Date.now(),
          selectionContext
        });
        
        // Update node metadata
        textNode.fingerprint = newFingerprint;
        textNode.likelyCompliant = true;
        textNode.recentlyFixed = true;
        
        console.log(`✅ Successfully applied fix to ${nodeId}:`);
        console.log(`   Old: "${oldContent}"`);
        console.log(`   New: "${newContent}"`);
        
        figma.ui.postMessage({
          type: 'fix-applied',
          nodeId,
          message: `Updated "${textNode.name}"`,
          newFingerprint
        });
        
      } catch (error: any) {
        console.error(`❌ Fix failed for node ${msg.nodeId}:`, error);
        figma.ui.postMessage({
          type: 'error',
          message: `Fix failed: ${error.message}`
        });
      }
      break;
      
    case 'apply-all-fixes':
      try {
        const { fixes } = msg;
        const selectionContext = createSelectionContext(figma.currentPage.selection);
        let successCount = 0;
        let errorCount = 0;
        const errors: string[] = [];
        const appliedFixes: string[] = [];
        
        console.log(`🔧 Applying ${fixes.length} fixes...`);
        
        for (const fix of fixes) {
          try {
            const textNode = selectedTextNodes.find(node => node.id === fix.nodeId);
            if (!textNode) {
              console.error(`❌ Text node ${fix.nodeId} not found`);
              errorCount++;
              errors.push(`Node ${fix.nodeId} not found`);
              continue;
            }
            
            const figmaNode = textNode.node;
            
            if (!figmaNode || figmaNode.type !== 'TEXT') {
              console.error(`❌ Invalid node type for ${fix.nodeId}`);
              errorCount++;
              errors.push(`Invalid node type for ${fix.nodeId}`);
              continue;
            }
            
            // Test node accessibility
            try {
              const testAccess = figmaNode.characters;
            } catch (accessError: any) {
              console.error(`❌ Cannot access node ${fix.nodeId}:`, accessError);
              errorCount++;
              errors.push(`Cannot access node ${fix.nodeId}`);
              continue;
            }
            
            // Load fonts for this specific node
            await loadNodeFonts(figmaNode);
            
            // Apply the fix
            const oldContent = figmaNode.characters;
            figmaNode.characters = fix.newContent;
            
            // Update local state and registry
            textNode.characters = fix.newContent;
            
            const oldFingerprint = createTextFingerprint(oldContent);
            const newFingerprint = createTextFingerprint(fix.newContent);
            
            fixedTextRegistry.set(newFingerprint, {
              originalText: oldContent,
              correctedText: fix.newContent,
              fixedAt: Date.now(),
              layerId: fix.nodeId,
              selectionContext
            });
            
            // Track as recently fixed
            recentlyFixedInCurrentSession.set(fix.nodeId, {
              fixedAt: Date.now(),
              selectionContext
            });
            
            textNode.fingerprint = newFingerprint;
            textNode.likelyCompliant = true;
            textNode.recentlyFixed = true;
            
            console.log(`✅ Fixed ${fix.nodeId}: "${oldContent}" → "${fix.newContent}"`);
            appliedFixes.push(fix.nodeId);
            successCount++;
            
          } catch (itemError: any) {
            console.error(`❌ Error applying fix to ${fix.nodeId}:`, itemError);
            errorCount++;
            errors.push(`${fix.nodeId}: ${itemError.message || 'Unknown error'}`);
          }
        }
        
        console.log(`📊 Bulk fix results: ${successCount} success, ${errorCount} errors`);
        
        figma.ui.postMessage({
          type: 'all-fixes-applied',
          successCount,
          errorCount,
          appliedFixes,
          message: errorCount === 0 
            ? `✅ Successfully applied all ${successCount} fixes!`
            : `⚠️ Applied ${successCount} fixes, ${errorCount} failed`,
          errors: errorCount > 0 ? errors : undefined
        });
        
      } catch (error: any) {
        console.error(`❌ Bulk fix failed:`, error);
        figma.ui.postMessage({
          type: 'error',
          message: `Bulk fix failed: ${error.message}`
        });
      }
      break;
  }
};
