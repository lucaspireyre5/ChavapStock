/* Cha'Vap Stock V2 — accès Supabase (aucun secret serveur côté navigateur). */
(() => {
  'use strict';
  const BUCKET = 'chavap-produits';
  const TABLE_PRODUCTS = 'chavap_products';
  const TABLE_MOVEMENTS = 'chavap_movements';
  const MAX_BACKUP_SIZE = 250 * 1024 * 1024;
  const REGEX_ID = /^[\w-]{1,120}$/;

  const ensure = (result) => {
    if (result.error) throw new Error(result.error.message || 'Erreur Supabase.');
    return result.data;
  };
  const guid = () => crypto.randomUUID();
  const cleanData = (object) => {
    const {id, image, imagePath, _dbUpdatedAt, ...data} = object;
    delete data._cloud;
    return data;
  };
  function bufferAsDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Impossible de lire une photo de sauvegarde.'));
      reader.readAsDataURL(blob);
    });
  }
  function decodeDataURL(uri) {
    const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(uri);
    if (!match || uri.length > 1_800_000) throw new Error('Image invalide ou trop volumineuse.');
    const binary = atob(match[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i=0; i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
    const mime = uri.slice(5,uri.indexOf(';'));
    return new Blob([bytes], {type:mime});
  }
  async function makeWebp(dataUrl) {
    const blob = decodeDataURL(dataUrl);
    if (blob.type === 'image/webp') return blob;
    const bitmap = await createImageBitmap(blob);
    try {
      const ratio = Math.min(1,860/Math.max(bitmap.width,bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1,Math.round(bitmap.width*ratio));
      canvas.height = Math.max(1,Math.round(bitmap.height*ratio));
      canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
      const webp = await new Promise(resolve => canvas.toBlob(resolve,'image/webp',.77));
      if (!webp || webp.size > 2*1024*1024) throw new Error('Photo trop lourde.');
      return webp;
    } finally {bitmap.close();}
  }
  class Cloud {
    constructor(url, key) {
      if (!window.supabase?.createClient) throw new Error('La bibliothèque Supabase ne se charge pas. Vérifiez la connexion Internet.');
      this.client = window.supabase.createClient(url, key, {auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
      this.images = new Map();
      this.user = null;
      this.channel = null;
    }
    async session() {
      const {data,error} = await this.client.auth.getUser();
      if (error && !/session missing|auth session missing/i.test(error.message)) throw error;
      this.user = data?.user || null;
      return this.user;
    }
    async login(identifier,password) {
      const name=String(identifier||'').trim();
      if (!name || !password) throw new Error('Saisissez votre identifiant et votre mot de passe.');
      let email=name;
      if (!name.includes('@')) {
        // L'e-mail technique n'est jamais saisi par la gérante. La fonction SQL
        // n'expose aucun mot de passe et ne retourne un e-mail que pour un membre autorisé.
        const {data,error}=await this.client.rpc('chavap_resolve_login',{p_username:name});
        if (error) {
          if (/could not find the function|does not exist|schema cache/i.test(error.message||''))
            throw new Error('Connexion par identifiant non activée. Exécutez MISE_A_JOUR_IDENTIFIANTS.sql dans Supabase.');
          throw new Error('Impossible de vérifier cet identifiant. Réessayez.');
        }
        if (typeof data !== 'string' || !data) throw new Error('Identifiant ou mot de passe incorrect.');
        email=data;
      }
      const result=await this.client.auth.signInWithPassword({email,password});
      if (result.error) throw new Error('Identifiant ou mot de passe incorrect.');
      await this.session();
      if (!await this.isMember()) {
        await this.logout();
        throw new Error('Ce compte n’est pas autorisé à accéder à Cha’Vap Stock.');
      }
      return this.user;
    }
    async changePassword(currentPassword,newPassword) {
      if (!this.user) throw new Error('Vous devez être connecté.');
      if (newPassword.length < 12) throw new Error('Utilisez au moins 12 caractères pour le nouveau mot de passe.');
      ensure(await this.client.auth.updateUser({password:newPassword,current_password:currentPassword}));
    }
    async isMember() {
      if (!this.user) return false;
      const {data,error} = await this.client.from('chavap_members').select('user_id').eq('user_id',this.user.id).maybeSingle();
      if (error) throw new Error('Accès refusé ou installation SQL incomplète : ' + error.message);
      return !!data;
    }
    async logout() {
      this.stopUpdates();
      this.images.clear();
      await this.client.auth.signOut();
      this.user = null;
    }
    async pages(table, columns) {
      const rows=[];
      for (let offset=0; ;offset+=1000) {
        const page = ensure(await this.client.from(table).select(columns).order('created_at',{ascending:true}).range(offset,offset+999));
        rows.push(...page);
        if (page.length<1000) return rows;
        if (offset>100000) throw new Error('Trop de données pour ce chargement.');
      }
    }
    async signedPhotos(rows) {
      const wanted=[...new Set(rows.map(r=>r.image_path).filter(Boolean))];
      const missing=wanted.filter(path=>!this.images.has(path) || this.images.get(path).until<Date.now());
      for (let i=0;i<missing.length;i+=60) {
        const slice=missing.slice(i,i+60);
        const data=ensure(await this.client.storage.from(BUCKET).createSignedUrls(slice,3600));
        for (let j=0;j<slice.length;j++) {
          if (data[j]?.error || !data[j]?.signedUrl) {
            console.warn('Photo momentanément inaccessible :',slice[j],data[j]?.error);
            continue;
          }
          this.images.set(slice[j], {url:data[j].signedUrl,until:Date.now()+50*60*1000});
        }
      }
    }
    async refresh() {
      if (!this.user) throw new Error('Vous devez être connecté.');
      const [products, movements] = await Promise.all([
        this.pages(TABLE_PRODUCTS,'id,data,image_path,created_at,updated_at'),
        this.pages(TABLE_MOVEMENTS,'id,data,created_at')
      ]);
      // Les URL signées expirent et ne doivent jamais être intégrées aux sauvegardes.
      await this.signedPhotos(products);
      return {
        products:products.map(r=>({...r.data,id:r.id,createdAt:r.created_at,updatedAt:r.updated_at,
          imagePath:r.image_path || '',image:r.image_path ? this.images.get(r.image_path)?.url || '' : '',_dbUpdatedAt:r.updated_at})),
        movements:movements.map(r=>({...r.data,id:r.id,createdAt:r.created_at}))
      };
    }
    async photoUpload(dataUrl) {
      if (!this.user) throw new Error('Session expirée.');
      const blob=await makeWebp(dataUrl);
      const path=`${this.user.id}/${guid()}.webp`;
      ensure(await this.client.storage.from(BUCKET).upload(path,blob,{contentType:'image/webp',upsert:false,cacheControl:'3600'}));
      return path;
    }
    async cleanup(paths) {
      if (!paths.length) return;
      try {ensure(await this.client.storage.from(BUCKET).remove(paths));}
      catch(e) {console.warn('Photos temporaires à nettoyer :', paths, e);}
    }
    async saveProduct(product, original) {
      let imagePath=original?.imagePath || '';
      let newlyUploaded=[];
      const photo=product.image;
      if (!photo) imagePath='';
      else if (photo.startsWith('data:')) {
        imagePath=await this.photoUpload(photo);
        newlyUploaded.push(imagePath);
      } else if (original && photo !== original.image) {
        throw new Error('Photo de produit non reconnue. Rechargez la page.');
      }
      try {
        ensure(await this.client.rpc('chavap_save_product',{
          p_id:product.id,p_data:cleanData(product),p_image_path:imagePath || null,
          p_expected_updated_at:original?._dbUpdatedAt || null
        }));
      } catch(e) {
        // Une requête réseau peut avoir réussi côté serveur avant de perdre sa réponse.
        // Ne PAS supprimer la photo dans ce cas : elle pourrait être référencée en base.
        console.warn('Vérifier la fiche après un échec réseau :',newlyUploaded,e);
        throw e;
      }
    }
    async stock(productId,type,amount,note) {
      ensure(await this.client.rpc('chavap_change_stock', {p_id:productId,p_type:type,p_amount:amount,p_note:note}));
    }
    async deleteProduct(product) {
      ensure(await this.client.rpc('chavap_delete_product',{p_id:product.id,p_expected_updated_at:product._dbUpdatedAt}));
      // Photos non supprimées automatiquement : évite de détruire des fichiers utiles à une restauration.
    }
    async reset() {ensure(await this.client.rpc('chavap_reset_all'));}
    async backup(products,movements,onProgress) {
      // Photos incluses DANS le JSON. Si une seule photo est inaccessible, aucun export incomplet n'est proposé.
      const payload={format:'chavap-stock',version:2,exportedAt:new Date().toISOString(),
        products:[],movements:movements.map(m=>({...cleanData(m),id:m.id})),
        note:'Sauvegarde complète ChaVap Stock V2, y compris les photos privées.'};
      for (let i=0;i<products.length;i++) {
        const p=products[i];
        let image='';
        if (p.imagePath) {
          const blob=ensure(await this.client.storage.from(BUCKET).download(p.imagePath));
          image=await bufferAsDataURL(blob);
        }
        payload.products.push({...cleanData(p),id:p.id,image});
        if (onProgress) onProgress(i+1,products.length);
      }
      return payload;
    }
    async restore(products,movements,onProgress) {
      if (!this.user) throw new Error('Session expirée.');
      const newPaths=[];
      const rows=[];
      let rpcStarted=false;
      try {
        for (let i=0;i<products.length;i++) {
          const p=products[i];
          let path=null;
          if (p.image) {
            path=await this.photoUpload(p.image);
            newPaths.push(path);
          }
          rows.push({id:p.id,data:cleanData(p),image_path:path,created_at:p.createdAt});
          onProgress?.(i+1,products.length);
        }
        const moves=movements.map(m=>({id:m.id,data:cleanData(m),created_at:m.at}));
        rpcStarted=true;
        ensure(await this.client.rpc('chavap_restore_backup',{p_products:rows,p_movements:moves}));
      } catch(e) {
        // Si l'envoi des photos échoue, les anciennes fiches n'ont pas été touchées.
        // RPC transactionnelle, donc aucun effacement partiel des fiches/mouvements.
        if (!rpcStarted) await this.cleanup(newPaths);
        // Après l'appel RPC, une coupure réseau ne permet pas de savoir si le commit a eu lieu.
        // Conserver les images pour ne pas casser une restauration éventuellement réussie.
        throw e;
      }
      this.images.clear();
    }
    startUpdates(callback) {
      this.stopUpdates();
      this.channel=this.client.channel('chavap-stock-updates')
        .on('postgres_changes',{event:'*',schema:'public',table:TABLE_PRODUCTS},callback)
        .on('postgres_changes',{event:'*',schema:'public',table:TABLE_MOVEMENTS},callback)
        .subscribe();
    }
    stopUpdates() {
      if (this.channel) this.client.removeChannel(this.channel);
      this.channel=null;
    }
  }
  window.ChavapCloud={
    create(config) {
      const url=String(config?.url||'').trim();
      const key=String(config?.anonKey||'').trim();
      if (!/^https:\/\/[a-z\d-]+\.supabase\.co\/?$/.test(url) || key.length<20 || /VOTRE-PROJET|COLLER_ICI/i.test(url+key)) {
        throw new Error('Configuration manquante : renseignez config.js avec l’URL Supabase et la clé publishable/anon.');
      }
      return new Cloud(url,key);
    },
    MAX_BACKUP_SIZE, REGEX_ID
  };
})();
